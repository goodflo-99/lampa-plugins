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

		observerStarted: false,
		skipWatcherStarted: false,
		timelineWatcherStarted: false,
		styleInjected: false
	};

	function hasSkipSegments(obj) {
		return !!(obj && obj.segments && Array.isArray(obj.segments.skip) && obj.segments.skip.length);
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
				start = Number(seg.start ?? seg.from ?? seg.begin ?? seg.time ?? seg[0]);
				end = Number(seg.end ?? seg.to ?? seg.stop ?? seg[1]);
			}

			if (!isFinite(start) || !isFinite(end) || end <= start) return null;

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
				episode: parseInt(videoParams.episode || videoParams.e || videoParams.episode_number),
				index: 0
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

		return {
			season: parseInt(defaultSeason || 1),
			episode: 1,
			index: 0
		};
	}

	function detectCurrentUrl() {
		try {
			return (Lampa.Player && Lampa.Player.video && (Lampa.Player.video.src || Lampa.Player.video.url)) || null;
		} catch (e) {
			return null;
		}
	}

	function detectCurrentIndexRaw() {
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

	function getCurrentIndexSafe() {
		const idx = detectCurrentIndexRaw();
		if (idx >= 0) return idx;
		if (state.lastIndex >= 0) return state.lastIndex;
		return state.baseIndex || 0;
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
			episode: episode,
			index: index
		};
	}

	function clearItemSegments(item) {
		if (!item || !item.segments) return;
		if (item.segments.skip) delete item.segments.skip;
		if (!Object.keys(item.segments).length) delete item.segments;
	}

	function setItemSegments(item, rawSegments) {
		if (!item) return;

		if (rawSegments && rawSegments.length > 0) {
			item.segments = item.segments || {};
			item.segments.skip = rawSegments.slice();
		} else {
			clearItemSegments(item);
		}
	}

	function fillPlaylistAhead() {
		if (!state.playlist || !state.db) return;

		state.playlist.forEach(function (item, index) {
			const info = getEpisodeInfoByIndex(index);
			if (!info) return;

			const raw = getSegmentsFromDb(state.db, info.season, info.episode);
			setItemSegments(item, raw);
		});
	}

	function setCurrentEpisodeSegments(index, notify) {
		const info = getEpisodeInfoByIndex(index);
		if (!info || !state.db) return;

		const raw = getSegmentsFromDb(state.db, info.season, info.episode);
		const normalized = normalizeSegments(raw);
		const key = info.season + "|" + info.episode + "|" + index;

		state.activeEpisodeKey = key;
		state.activeSegments = normalized;
		state.skippedMarks = {};

		setItemSegments(info.item, raw);

		try {
			if (Lampa.Player && Lampa.Player.object) {
				Lampa.Player.object.segments = Lampa.Player.object.segments || {};
				if (raw && raw.length > 0) {
					Lampa.Player.object.segments.skip = raw.slice();
				} else if (Lampa.Player.object.segments.skip) {
					delete Lampa.Player.object.segments.skip;
				}
			}
		} catch (e) {}

		if (notify) {
			Lampa.Noty.show(
				"Таймкоди: Сезон " + info.season + ", Серія " + info.episode + (normalized.length ? "" : " — немає")
			);
		}

		scheduleTimelineRender();
	}

	function injectTimelineStyle() {
		if (state.styleInjected) return;
		state.styleInjected = true;

		const style = document.createElement("style");
		style.textContent = `
			.custom-skip-segment {
				position: absolute;
				top: 0;
				bottom: 0;
				border-radius: 999px;
				pointer-events: none;
				background: rgba(70, 170, 255, 0.65);
				box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18);
				z-index: 2;
			}
		`;
		document.head.appendChild(style);
	}

	function renderTimelineSegments() {
		try {
			injectTimelineStyle();

			const timeline = document.querySelector(".player-panel__timeline");
			const video = Lampa.Player && Lampa.Player.video;

			if (!timeline || !video) return;

			timeline.querySelectorAll(".custom-skip-segment").forEach(el => el.remove());

			const duration = Number(video.duration || 0);
			if (!isFinite(duration) || duration <= 0) return;
			if (!state.activeSegments || !state.activeSegments.length) return;

			const pos = window.getComputedStyle(timeline).position;
			if (!pos || pos === "static") {
				timeline.style.position = "relative";
			}

			state.activeSegments.forEach(function (seg) {
				const width = ((seg.end - seg.start) / duration) * 100;
				const left = (seg.start / duration) * 100;

				if (width <= 0) return;

				const el = document.createElement("div");
				el.className = "custom-skip-segment";
				el.style.left = left + "%";
				el.style.width = width + "%";
				timeline.appendChild(el);
			});
		} catch (e) {}
	}

	function scheduleTimelineRender() {
		setTimeout(renderTimelineSegments, 250);
		setTimeout(renderTimelineSegments, 900);
		setTimeout(renderTimelineSegments, 1800);
	}

	function startTimelineWatcher() {
		if (state.timelineWatcherStarted) return;
		state.timelineWatcherStarted = true;

		setInterval(function () {
			if (!state.activeSegments || !state.activeSegments.length) return;
			renderTimelineSegments();
		}, 1500);
	}

	function startRuntimeSkipWatcher() {
		if (state.skipWatcherStarted) return;
		state.skipWatcherStarted = true;

		setInterval(function () {
			try {
				const video = Lampa.Player && Lampa.Player.video;
				if (!video || !state.activeSegments || !state.activeSegments.length || !state.activeEpisodeKey) return;

				const currentTime = Number(video.currentTime || 0);
				if (!isFinite(currentTime)) return;

				for (let i = 0; i < state.activeSegments.length; i++) {
					const seg = state.activeSegments[i];
					const markKey = state.activeEpisodeKey + "|" + seg.id;

					if (state.skippedMarks[markKey]) continue;

					if (currentTime >= seg.start && currentTime < seg.end - 0.15) {
						state.skippedMarks[markKey] = true;

						try {
							video.currentTime = seg.end + 0.05;
						} catch (e) {}

						break;
					}

					if (state.skippedMarks[markKey] && currentTime < seg.start - 3) {
						delete state.skippedMarks[markKey];
					}
				}
			} catch (e) {}
		}, 250);
	}

	function startObserver() {
		if (state.observerStarted) return;
		state.observerStarted = true;

		setInterval(function () {
			if (!state.playlist || !state.playlist.length || !state.db) return;

			const idx = detectCurrentIndexRaw();
			const url = detectCurrentUrl();

			if (idx >= 0 && (idx !== state.lastIndex || url !== state.lastUrl)) {
				state.lastIndex = idx;
				state.lastUrl = url;
				setCurrentEpisodeSegments(idx, true);
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

		const position = detectPosition(videoParams, 1);
		state.baseSeason = position.season || 1;
		state.baseEpisode = position.episode || 1;
		state.baseIndex = position.index || 0;

		state.db = await fetchFromGitHub(kpId);
		if (!state.db) return;

		if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
			state.playlist = videoParams.playlist;
		}

		fillPlaylistAhead();

		const raw = getSegmentsFromDb(state.db, state.baseSeason, state.baseEpisode);
		if (raw && raw.length > 0) {
			videoParams.segments = videoParams.segments || {};
			videoParams.segments.skip = raw.slice();
			Lampa.Noty.show("Таймкоди завантажено: Сезон " + state.baseSeason + ", Серія " + state.baseEpisode);
		} else if (videoParams.segments && videoParams.segments.skip) {
			delete videoParams.segments.skip;
			if (!Object.keys(videoParams.segments).length) delete videoParams.segments;
		}

		state.lastIndex = state.baseIndex;
		state.lastUrl = videoParams.url || null;
		setCurrentEpisodeSegments(getCurrentIndexSafe(), false);
	}

	function init() {
		if (window.lampa_series_skip_production_fix) return;
		window.lampa_series_skip_production_fix = true;

		const originalPlay = Lampa.Player.play;
		const originalPlaylist = Lampa.Player.playlist;
		let pendingPlaylist = null;

		Lampa.Player.playlist = function (playlist) {
			pendingPlaylist = playlist;

			if (playlist && Array.isArray(playlist)) {
				state.playlist = playlist;
				if (state.db) fillPlaylistAhead();
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

					startObserver();
					startRuntimeSkipWatcher();
					startTimelineWatcher();
					scheduleTimelineRender();
				})
				.catch(function () {
					originalPlay.call(context, videoParams);
					startObserver();
					startRuntimeSkipWatcher();
					startTimelineWatcher();
				});
		};

		startObserver();
		startRuntimeSkipWatcher();
		startTimelineWatcher();
	}

	if (window.Lampa && window.Lampa.Player) {
		init();
	} else {
		window.document.addEventListener("app_ready", init);
	}
})();
