(function () {
	"use strict";

	const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";

	let cache = {
		kpId: null,
		card: null,
		db: null,
		playlist: null,
		lastUrl: null,
		lastIndex: -1,
		startEpisode: 1,
		season: 1,
		observerStarted: false
	};

	function hasExistingSegments(obj) {
		return obj && obj.segments && Array.isArray(obj.segments.skip) && obj.segments.skip.length > 0;
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
		try {
			const response = await fetch(`${GITHUB_DB_URL}${kpId}.json`);
			return response.ok ? await response.json() : null;
		} catch (e) {
			return null;
		}
	}

	function calcStartEpisode(playlist) {
		if (!playlist || !playlist.length) return 1;

		for (let i = 0; i < playlist.length; i++) {
			const item = playlist[i];
			const ep = parseInt(item.episode || item.e || item.episode_number);
			if (!isNaN(ep) && ep > 0) {
				return Math.max(1, ep - i);
			}
		}
		return 1;
	}

	function getEpisodeFromItem(item, index) {
		const ep = parseInt(item.episode || item.e || item.episode_number);
		if (!isNaN(ep) && ep > 0) return ep;
		return cache.startEpisode + index;
	}

	function getSeasonFromItem(item) {
		const s = parseInt(item.season || item.s || cache.season || 1);
		return !isNaN(s) && s > 0 ? s : 1;
	}

	function fillPlaylist(playlist) {
		if (!playlist || !Array.isArray(playlist) || !cache.db) return;

		cache.startEpisode = calcStartEpisode(playlist);

		playlist.forEach((item, index) => {
			const season = getSeasonFromItem(item);
			const episode = getEpisodeFromItem(item, index);
			const segs = getSegmentsFromDb(cache.db, season, episode);

			if (segs && segs.length > 0) {
				item.segments = item.segments || {};
				item.segments.skip = segs.slice();
			} else if (item.segments && item.segments.skip) {
				delete item.segments.skip;
				if (!Object.keys(item.segments).length) delete item.segments;
			}
		});
	}

	function detectCurrentIndex() {
		if (!cache.playlist || !cache.playlist.length) return -1;

		let idx = cache.playlist.findIndex(item => item.selected);
		if (idx >= 0) return idx;

		try {
			const currentUrl =
				(Lampa.Player && Lampa.Player.video && (Lampa.Player.video.src || Lampa.Player.video.url)) || null;

			if (currentUrl) {
				idx = cache.playlist.findIndex(item => item.url && item.url === currentUrl);
				if (idx >= 0) return idx;
			}
		} catch (e) {}

		return -1;
	}

	function applyForCurrentItem(forceNotify) {
		if (!cache.db || !cache.playlist) return;

		const idx = detectCurrentIndex();
		if (idx < 0 || !cache.playlist[idx]) return;

		const item = cache.playlist[idx];
		const season = getSeasonFromItem(item);
		const episode = getEpisodeFromItem(item, idx);
		const segs = getSegmentsFromDb(cache.db, season, episode);

		if (segs && segs.length > 0) {
			item.segments = item.segments || {};
			item.segments.skip = segs.slice();

			try {
				if (Lampa.Player && Lampa.Player.object) {
					Lampa.Player.object.segments = Lampa.Player.object.segments || {};
					Lampa.Player.object.segments.skip = segs.slice();
				}
			} catch (e) {}

			if (forceNotify) {
				Lampa.Noty.show("Таймкоди: Сезон " + season + ", Серія " + episode);
			}
		} else {
			if (item.segments && item.segments.skip) {
				delete item.segments.skip;
				if (!Object.keys(item.segments).length) delete item.segments;
			}

			try {
				if (Lampa.Player && Lampa.Player.object && Lampa.Player.object.segments) {
					delete Lampa.Player.object.segments.skip;
				}
			} catch (e) {}
		}

		cache.lastIndex = idx;
		cache.lastUrl = item.url || null;
	}

	function startObserver() {
		if (cache.observerStarted) return;
		cache.observerStarted = true;

		setInterval(function () {
			if (!cache.db || !cache.playlist || !cache.playlist.length) return;

			const idx = detectCurrentIndex();
			if (idx < 0 || !cache.playlist[idx]) return;

			const currentUrl = cache.playlist[idx].url || null;

			if (idx !== cache.lastIndex || currentUrl !== cache.lastUrl) {
				applyForCurrentItem(true);
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

		if (!card && cache.card) card = cache.card;
		if (!card) return;

		const kpId = getKpId(card);
		if (!kpId) return;

		cache.card = card;

		const season = parseInt(videoParams.season || videoParams.s || 1) || 1;
		cache.season = season;

		if (kpId !== cache.kpId || !cache.db) {
			cache.db = await fetchFromGitHub(kpId);
			cache.kpId = kpId;
		}

		if (!cache.db) return;

		if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
			cache.playlist = videoParams.playlist;
			fillPlaylist(cache.playlist);
		}

		if (videoParams.url && cache.playlist) {
			const idx = cache.playlist.findIndex(item => item.url === videoParams.url);
			if (idx >= 0) {
				cache.lastIndex = -1;
				cache.lastUrl = null;
				applyForCurrentItem(true);
			}
		}

		startObserver();
	}

	function init() {
		if (window.lampa_series_skip_fix_v2) return;
		window.lampa_series_skip_fix_v2 = true;

		const originalPlay = Lampa.Player.play;
		const originalPlaylist = Lampa.Player.playlist;

		Lampa.Player.playlist = function (playlist) {
			if (playlist && Array.isArray(playlist)) {
				cache.playlist = playlist;
				if (cache.db) fillPlaylist(playlist);
			}
			return originalPlaylist.apply(this, arguments);
		};

		Lampa.Player.play = function (videoParams) {
			const context = this;

			searchAndApply(videoParams)
				.then(function () {
					originalPlay.call(context, videoParams);
					setTimeout(function () {
						applyForCurrentItem(false);
					}, 300);
				})
				.catch(function () {
					originalPlay.call(context, videoParams);
				});
		};

		startObserver();
	}

	if (window.Lampa && window.Lampa.Player) {
		init();
	} else {
		window.document.addEventListener("app_ready", init);
	}
})();
