(function () {
	"use strict";

	const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";
	const DB_CACHE = {};

	function hasExistingSegments(obj) {
		return obj && obj.segments && obj.segments.skip && obj.segments.skip.length > 0;
	}

	function getSegmentsFromDb(dbData, season, episode) {
		if (!dbData) return null;

		const seasonStr = String(season);
		const episodeStr = String(episode);

		if (dbData[seasonStr] && dbData[seasonStr][episodeStr]) {
			return dbData[seasonStr][episodeStr];
		}

		if (seasonStr === "1" && episodeStr === "1" && dbData.movie) {
			return dbData.movie;
		}

		if (dbData.movie) {
			return dbData.movie;
		}

		return null;
	}

	async function fetchFromGitHub(kpId) {
		if (DB_CACHE[kpId]) return DB_CACHE[kpId];

		try {
			const url = `${GITHUB_DB_URL}${kpId}.json`;
			const response = await fetch(url);
			const data = response.ok ? await response.json() : null;
			if (data) DB_CACHE[kpId] = data;
			return data;
		} catch (e) {
			return null;
		}
	}

	function detectPosition(videoParams, defaultSeason = 1) {
		if (videoParams.episode || videoParams.e || videoParams.episode_number) {
			return {
				season: parseInt(videoParams.season || videoParams.s || defaultSeason),
				episode: parseInt(videoParams.episode || videoParams.e || videoParams.episode_number),
			};
		}

		if (videoParams.playlist && Array.isArray(videoParams.playlist) && videoParams.url) {
			const index = videoParams.playlist.findIndex((p) => p.url && p.url === videoParams.url);

			if (index !== -1) {
				const item = videoParams.playlist[index];
				return {
					season: parseInt(item.season || item.s || defaultSeason),
					episode: parseInt(item.episode || item.e || item.episode_number || (index + 1)),
				};
			}
		}

		return { season: defaultSeason, episode: 1 };
	}

	function fillPlaylist(playlist, dbData, fallbackSeason) {
		if (!playlist || !Array.isArray(playlist) || !dbData) return;

		playlist.forEach((item, index) => {
			const itemSeason = parseInt(item.season || item.s || fallbackSeason || 1);
			const itemEpisode = parseInt(item.episode || item.e || item.episode_number || (index + 1));
			const itemSegments = getSegmentsFromDb(dbData, itemSeason, itemEpisode);

			if (itemSegments && itemSegments.length > 0) {
				item.segments = item.segments || {};
				item.segments.skip = itemSegments.slice();
			}
		});
	}

	async function searchAndApply(videoParams) {
		let card = videoParams.movie || videoParams.card;

		if (!card) {
			const active = Lampa.Activity.active();
			if (active) card = active.movie || active.card;
		}
		if (!card) return;

		const kpId =
			card.kinopoisk_id ||
			(card.source === "kinopoisk" ? card.id : null) ||
			card.kp_id;

		if (!kpId) return;

		const position = detectPosition(videoParams, 1);
		let season = position.season;
		let episode = position.episode;

		const isSerial = card.number_of_seasons > 0 || (card.original_name && !card.original_title);
		if (!isSerial) {
			season = 1;
			episode = 1;
		}

		const dbData = await fetchFromGitHub(kpId);
		if (!dbData) return;

		const segmentsData = getSegmentsFromDb(dbData, season, episode);
		if (segmentsData && segmentsData.length > 0 && !hasExistingSegments(videoParams)) {
			videoParams.segments = videoParams.segments || {};
			videoParams.segments.skip = segmentsData.slice();
			Lampa.Noty.show("Таймкоди завантажено: Сезон " + season + ", Серія " + episode);
		}

		if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
			fillPlaylist(videoParams.playlist, dbData, season);
		}
	}

	function init() {
		if (window.lampa_series_skip_fixed_safe) return;
		window.lampa_series_skip_fixed_safe = true;

		const originalPlay = Lampa.Player.play;
		const originalPlaylist = Lampa.Player.playlist;
		let pendingPlaylist = null;

		Lampa.Player.playlist = function (playlist) {
			pendingPlaylist = playlist;
			return originalPlaylist.call(this, playlist);
		};

		Lampa.Player.play = function (videoParams) {
			const context = this;

			if (videoParams.url) {
				Lampa.PlayerPlaylist.url(videoParams.url);
			}

			if (videoParams.playlist && videoParams.playlist.length > 0) {
				Lampa.PlayerPlaylist.set(videoParams.playlist);
			}

			searchAndApply(videoParams)
				.then(() => {
					originalPlay.call(context, videoParams);

					if (pendingPlaylist) {
						Lampa.PlayerPlaylist.set(pendingPlaylist);
						pendingPlaylist = null;
					}
				})
				.catch(() => {
					originalPlay.call(context, videoParams);
				});
		};
	}

	if (window.Lampa && window.Lampa.Player) {
		init();
	} else {
		window.document.addEventListener("app_ready", init);
	}
})();
