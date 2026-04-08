(function () {
	"use strict";

	const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";
	const DB_CACHE = {};

	const state = {
		kpId: null,
		card: null,
		db: null,
		playlist: null,
		baseSeason: 1,
		baseEpisode: 1,
		baseIndex: 0,
		lastIndex: -1,
		lastUrl: null,
		activeEpisodeKey: null,
		activeSegments: [],
		skippedMarks: {},
		videoBound: false,
		observerStarted: false
	};

	function hasExistingSegments(obj) {
		return obj && obj.segments && obj.segments.skip && obj.segments.skip.length > 0;
	}

	function getKpId(card) {
		if (!card) return null;
		return card.kinopoisk_id || (card.source === "kinopoisk" ? card.id : null) || card.kp_id;
	}

	function getSegmentsFromDb(dbData, season, episode) {
		if (!dbData) return null;

		const s = String(season);
		const e = String(episode);

		if (dbData[s] && dbData[s][e]) return dbData[s][e];
		if (s === "1" && e === "1" && dbData.movie) return dbData.movie;
		if (dbData.movie) return dbData.movie;

		return null;
	}

	async function fetchFromGitHub(kpId) {
		if (DB_CACHE[kpId]) return DB_CACHE[kpId];

		try {
			const response = await fetch(`${GITHUB_DB_URL}${kpId}.json`);
			const data = response.ok ? await response.json() : null;
			if (data) DB_CACHE[kpId] = data;
			return data;
		} catch (e) {
			return null;
		}
	}

	function normalizeSegments(raw) {
		if (!Array.isArray(raw)) return [];

		return raw.map(function (seg, index) {
			let start = null;
			let end = null;

			if (Array.isArray(seg)) {
				start = Number(seg[0]);
				end = Number(seg[1]);
			} else if (seg && typeof seg === "object") {
				start = Number(
					seg.start ?? seg.from ?? seg.begin ?? seg.time ?? seg[0]
				);
				end = Number(
					seg.end ?? seg.to ?? seg.stop ?? seg[1]
				);
			}

			if (!isFinite(start) || !isFinite(end)) return null;
			if (end <= start) return null;

			return {
				id: index,
				start: start,
				end: end
			};
		}).filter(Boolean);
	}

	function detectPosition(videoParams, defaultSeason) {
		if (videoParams.episode || videoParams.e || videoParams.episode_number) {
			return {
				season: parseInt(videoParams.season || videoParams.s || defaultSeason || 1),
				episode: parseInt(videoParams.episode || videoParams.e || videoParams.episode_number)
			};
		}

		if (videoParams.playlist && Array.isArray(videoParams.playlist) && videoParams.url) {
			const index = videoParams.playlist.findIndex((p) => p.url && p.url === videoParams.url);

			if (index !== -1) {
				const item = videoParams.playlist[index];
				return {
					season: parseInt(item.season || item.s || defaultSeason || 1),
					episode: parseInt(item.episode || item.e || item.episode_number || (index + 1)),
					index: index
				};
			}
		}

		return { season: defaultSeason || 1, episode: 1, index: 0 };
	}

	function detectCurrentUrl() {
		try {
			return (Lampa.Player && Lampa.Player.video && (Lampa.Player.video.src || Lampa.Player.video.url)) || null;
		} catch (e) {
			return null;
		}
	}

	function detectCurrentIndex() {
		if (!state.playlist || !state.playlist.length) return -1;

		let idx = state.playlist.findIndex(item => item && item.selected);
		if (idx >= 0) return idx;

		const url = detectCurrentUrl();
		if (url) {
			idx = state.playlist.findIndex(item => item && item.url === url);
			if (idx >= 0) return idx;
		}

		return -1;
	}

	function getEpisodeInfoByIndex(index) {
		if (!state.playlist || !state.playlist[index]) return null;

		const item = state.playlist[index];
		const season = parseInt(item.season || item.s || state.baseSeason || 1);

		const explicitEpisode = parseInt(item.episode || item.e || item.episode_number);
		const episode = (!isNaN(explicitEpisode) && explicitEpisode > 0)
			? explicitEpisode
			: Math.max(1, state.baseEpisode + (index - state.baseIndex));

		return {
			item: item,
			season: season,
			episode: episode
		};
	}

	function setSegmentsForCurrentEpisode(index, notify) {
		const info = getEpisodeInfoByIndex(index);
		if (!info || !state.db) return;

		const rawSegments = getSegmentsFromDb(state.db, info.season, info.episode);
		const normalized = normalizeSegments(rawSegments);
		const episodeKey = info.season + "|" + info.episode + "|" + index;

		state.activeEpisodeKey = episodeKey;
		state.activeSegments = normalized;
		state.skippedMarks = {};

		if (rawSegments && rawSegments.length > 0) {
			info.item.segments = info.item.segments || {};
			info.item.segments.skip = rawSegments.slice();
		} else if (info.item.segments && info.item.segments.skip) {
			delete info.item.segments.skip;
			if (!Object.keys(info.item.segments).length) delete info.item.segments;
		}

		if (notify) {
			Lampa.Noty.show(
				"Таймкоди: Сезон " + info.season + ", Серія " + info.episode + " — " + (normalized.length ? "OK" : "немає")
			);
		}
	}

	function bindVideoListener() {
		if (state.videoBound) return;

		const tryBind = function () {
			try {
				const video = Lampa.Player && Lampa.Player.video;
				if (!video || typeof video.addEventListener !== "function") {
					setTimeout(tryBind, 500);
					return;
				}

				video.addEventListener("timeupdate", function () {
					if (!state.activeSegments || !state.activeSegments.length) return;
					if (!state.activeEpisodeKey) return;

					const currentTime = Number(video.currentTime || 0);
					if (!isFinite(currentTime)) return;

					for (let i = 0; i < state.activeSegments.length; i++) {
						const seg = state.activeSegments[i];
						const markKey = state.activeEpisodeKey + "|" + seg.id;

						if (state.skippedMarks[markKey]) continue;

						if (currentTime >= seg.start && currentTime < seg.end - 0.2) {
							state.skippedMarks[markKey] = true;

							try {
								video.currentTime = seg.end + 0.05;
							} catch (e) {}

							break;
						}
					}
				});

				state.videoBound = true;
			} catch (e) {
				setTimeout(tryBind, 500);
			}
		};

		tryBind();
	}

	function startObserver() {
		if (state.observerStarted) return;
		state.observerStarted = true;

		setInterval(function () {
			if (!state.playlist || !state.playlist.length || !state.db) return;

			const idx = detectCurrentIndex();
			const url = detectCurrentUrl();

			if (idx !== state.lastIndex || url !== state.lastUrl) {
				state.lastIndex = idx;
				state.lastUrl = url;

				if (idx >= 0) {
					setSegmentsForCurrentEpisode(idx, true);
				}
			}
		}, 700);
	}

	async function searchAndApply(videoParams) {
		let card = videoParams.movie || videoParams.card;

		if (!card) {
			try {
				const active = Lampa.Activity.active();
				if (active) card = active.movie || active.card;
			} catch (e) {}
		}

		if (!card) return;

		const kpId = getKpId(card);
		if (!kpId) return;

		state.card = card;
		state.kpId = kpId;

		const pos = detectPosition(videoParams, 1);
		state.baseSeason = pos.season || 1;
		state.baseEpisode = pos.episode || 1;
		state.baseIndex = pos.index || 0;

		state.db = await fetchFromGitHub(kpId);
		if (!state.db) return;

		if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
			state.playlist = videoParams.playlist;
		}

		const rawSegments = getSegmentsFromDb(state.db, state.baseSeason, state.baseEpisode);

		if (rawSegments && rawSegments.length > 0) {
			videoParams.segments = videoParams.segments || {};
			videoParams.segments.skip = rawSegments.slice();

			state.activeSegments = normalizeSegments(rawSegments);
			state.activeEpisodeKey = state.baseSeason + "|" + state.baseEpisode + "|" + state.baseIndex;
			state.skippedMarks = {};

			Lampa.Noty.show("Таймкоди завантажено: Сезон " + state.baseSeason + ", Серія " + state.baseEpisode);
		} else {
			state.activeSegments = [];
			state.activeEpisodeKey = state.baseSeason + "|" + state.baseEpisode + "|" + state.baseIndex;
			state.skippedMarks = {};
		}

		if (state.playlist && state.playlist[state.baseIndex]) {
			const item = state.playlist[state.baseIndex];
			if (rawSegments && rawSegments.length > 0) {
				item.segments = item.segments || {};
				item.segments.skip = rawSegments.slice();
			}
		}
	}

	function init() {
		if (window.lampa_series_skip_manual_runtime_fix) return;
		window.lampa_series_skip_manual_runtime_fix = true;

		const originalPlay = Lampa.Player.play;
		const originalPlaylist = Lampa.Player.playlist;
		let pendingPlaylist = null;

		Lampa.Player.playlist = function (playlist) {
			pendingPlaylist = playlist;
			if (playlist && Array.isArray(playlist)) {
				state.playlist = playlist;
			}
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
				.then(function () {
					originalPlay.call(context, videoParams);

					if (pendingPlaylist) {
						Lampa.PlayerPlaylist.set(pendingPlaylist);
						pendingPlaylist = null;
					}

					bindVideoListener();
					startObserver();
				})
				.catch(function () {
					originalPlay.call(context, videoParams);
					bindVideoListener();
					startObserver();
				});
		};

		bindVideoListener();
		startObserver();
	}

	if (window.Lampa && window.Lampa.Player) {
		init();
	} else {
		window.document.addEventListener("app_ready", init);
	}
})();
