(function () {
	"use strict";

	const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";
	const DB_CACHE = {};

	const state = {
		kpId: null,
		db: null,
		card: null,
		playlist: null,
		currentSeason: 1,
		currentEpisode: 1,
		lastIndex: -1,
		lastUrl: null,
		lastAppliedKey: null,
		observer: null
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

	function debugBox() {
		let box = document.getElementById("skip-debug-box");

		if (!box) {
			box = document.createElement("div");
			box.id = "skip-debug-box";
			box.style.cssText = [
				"position:fixed",
				"top:1.2em",
				"right:1.2em",
				"z-index:999999",
				"background:rgba(0,0,0,.78)",
				"color:#fff",
				"padding:0.7em 0.9em",
				"border-radius:0.6em",
				"font-size:1.05em",
				"line-height:1.35",
				"max-width:46vw",
				"white-space:pre-line",
				"pointer-events:none"
			].join(";");

			document.body.appendChild(box);
		}

		return box;
	}

	function showDebug(lines) {
		const box = debugBox();
		box.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines);
	}

	function shortNoty(text) {
		try {
			Lampa.Noty.show(text);
		} catch (e) {}
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

	function detectPosition(videoParams, defaultSeason = 1) {
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
					episode: parseInt(item.episode || item.e || item.episode_number || (index + 1))
				};
			}
		}

		return { season: defaultSeason, episode: 1 };
	}

	function fillPlaylistRelative(playlist, dbData, currentSeason, currentEpisode, currentUrl) {
		if (!playlist || !Array.isArray(playlist) || !dbData) return;

		let currentIndex = playlist.findIndex(item => item && item.url && item.url === currentUrl);
		if (currentIndex < 0) currentIndex = 0;

		playlist.forEach((item, index) => {
			if (!item) return;

			const itemSeason = parseInt(item.season || item.s || currentSeason || 1);
			const explicitEpisode = parseInt(item.episode || item.e || item.episode_number);
			const itemEpisode = (!isNaN(explicitEpisode) && explicitEpisode > 0)
				? explicitEpisode
				: Math.max(1, currentEpisode + (index - currentIndex));

			const segs = getSegmentsFromDb(dbData, itemSeason, itemEpisode);

			if (segs && segs.length > 0) {
				item.segments = item.segments || {};
				item.segments.skip = segs.slice();
			} else if (item.segments && item.segments.skip) {
				delete item.segments.skip;
				if (!Object.keys(item.segments).length) delete item.segments;
			}
		});
	}

	function applyCurrentFromState(silent) {
		const idx = detectCurrentIndex();
		const url = detectCurrentUrl();

		if (idx < 0 || !state.playlist || !state.playlist[idx] || !state.db) {
			showDebug([
				"IDX: " + idx,
				"URL: " + (url ? "yes" : "no"),
				"DB: " + (!!state.db),
				"PLAYLIST: " + (!!state.playlist)
			]);
			return;
		}

		const item = state.playlist[idx];
		const season = parseInt(item.season || item.s || state.currentSeason || 1);
		const explicitEpisode = parseInt(item.episode || item.e || item.episode_number);
		const episode = (!isNaN(explicitEpisode) && explicitEpisode > 0)
			? explicitEpisode
			: Math.max(1, state.currentEpisode + (idx - Math.max(0, state.lastIndex < 0 ? idx : state.lastIndex)));

		const segs = getSegmentsFromDb(state.db, season, episode);
		const applyKey = idx + "|" + season + "|" + episode + "|" + (url || "");

		if (segs && segs.length > 0) {
			item.segments = item.segments || {};
			item.segments.skip = segs.slice();
		} else if (item.segments && item.segments.skip) {
			delete item.segments.skip;
			if (!Object.keys(item.segments).length) delete item.segments;
		}

		showDebug([
			"IDX: " + idx,
			"S/E: " + season + "/" + episode,
			"URL: " + (url ? "yes" : "no"),
			"SEG: " + (segs && segs.length > 0 ? "yes (" + segs.length + ")" : "no"),
			"ITEM_EP: " + (item.episode || item.e || item.episode_number || "fallback"),
			"NEXT: " + (!!(state.playlist[idx + 1]))
		]);

		if (!silent && state.lastAppliedKey !== applyKey) {
			state.lastAppliedKey = applyKey;
			shortNoty("DEBUG S" + season + "E" + episode + " SEG " + (segs && segs.length ? "YES" : "NO"));
		}
	}

	function startObserver() {
		if (state.observer) return;

		state.observer = setInterval(function () {
			if (!state.playlist || !state.playlist.length) return;

			const idx = detectCurrentIndex();
			const url = detectCurrentUrl();

			if (idx !== state.lastIndex || url !== state.lastUrl) {
				state.lastIndex = idx;
				state.lastUrl = url;
				applyCurrentFromState(false);
			}
		}, 800);
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
		state.currentSeason = pos.season;
		state.currentEpisode = pos.episode;

		state.db = await fetchFromGitHub(kpId);

		showDebug([
			"INIT",
			"KP: " + (kpId || "no"),
			"DB: " + (!!state.db),
			"S/E: " + pos.season + "/" + pos.episode
		]);

		if (!state.db) {
			shortNoty("DEBUG: DB not found");
			return;
		}

		if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
			state.playlist = videoParams.playlist;
			fillPlaylistRelative(videoParams.playlist, state.db, pos.season, pos.episode, videoParams.url);
		}

		const segs = getSegmentsFromDb(state.db, pos.season, pos.episode);

		if (segs && segs.length > 0) {
			videoParams.segments = videoParams.segments || {};
			videoParams.segments.skip = segs.slice();
			shortNoty("START S" + pos.season + "E" + pos.episode + " YES");
		} else {
			shortNoty("START S" + pos.season + "E" + pos.episode + " NO");
		}
	}

	function init() {
		if (window.lampa_series_skip_screen_debug) return;
		window.lampa_series_skip_screen_debug = true;

		const originalPlay = Lampa.Player.play;
		const originalPlaylist = Lampa.Player.playlist;
		let pendingPlaylist = null;

		Lampa.Player.playlist = function (playlist) {
			pendingPlaylist = playlist;
			state.playlist = playlist;
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

					startObserver();

					setTimeout(function () {
						applyCurrentFromState(true);
					}, 600);
				})
				.catch(() => {
					originalPlay.call(context, videoParams);
				});
		};

		startObserver();
		showDebug("WAIT PLAYER...");
	}

	if (window.Lampa && window.Lampa.Player) {
		init();
	} else {
		window.document.addEventListener("app_ready", init);
	}
})();
