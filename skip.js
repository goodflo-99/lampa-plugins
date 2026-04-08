(function () {
    "use strict";

    const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";

    // ── Кеш між епізодами ─────────────────────────────────────────────────────
    let cachedKpId   = null;
    let cachedDbData = null;
    let cachedCard   = null;
    let trackedPlaylist = null;   // посилання на поточний масив плейлиста
    let trackedIndex    = 0;      // поточний індекс у плейлисті

    // ── Утиліти ───────────────────────────────────────────────────────────────
    function hasExistingSegments(obj) {
        return obj && obj.segments && obj.segments.skip && obj.segments.skip.length > 0;
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
            const resp = await fetch(`${GITHUB_DB_URL}${kpId}.json`);
            return resp.ok ? await resp.json() : null;
        } catch (e) {
            return null;
        }
    }

    function getKpId(card) {
        if (!card) return null;
        return card.kinopoisk_id || (card.source === "kinopoisk" ? card.id : null) || card.kp_id;
    }

    // ── Наповнити ВСІ елементи плейлиста сегментами ───────────────────────────
    // ВИПРАВЛЕННЯ #2: використовуємо index+1 як запасний номер епізоду
    function populatePlaylist(playlist, dbData, defaultSeason) {
        if (!playlist || !Array.isArray(playlist) || !dbData) return;
        playlist.forEach((item, index) => {
            if (hasExistingSegments(item)) return;
            const itemSeason  = parseInt(item.season || item.s || defaultSeason || 1);
            const itemEpisode = parseInt(item.episode || item.e || item.episode_number || (index + 1));
            const segs = getSegmentsFromDb(dbData, itemSeason, itemEpisode);
            if (segs && segs.length > 0) {
                item.segments = item.segments || {};
                item.segments.skip = segs.slice();
            }
        });
    }

    // ── Застосувати сегменти до конкретного елементу плейлиста ────────────────
    // ВИПРАВЛЕННЯ #1: викликається після авто-перемикання серії
    function applyToItemAtIndex(index) {
        if (!cachedDbData || !trackedPlaylist) return;
        const item = trackedPlaylist[index];
        if (!item || hasExistingSegments(item)) return;

        const itemSeason  = parseInt(item.season || item.s || 1);
        const itemEpisode = parseInt(item.episode || item.e || item.episode_number || (index + 1));
        const segs = getSegmentsFromDb(cachedDbData, itemSeason, itemEpisode);
        if (segs && segs.length > 0) {
            item.segments = item.segments || {};
            item.segments.skip = segs.slice();
            Lampa.Noty.show("Таймкоди: Сезон " + itemSeason + ", Серія " + itemEpisode);
        }
    }

    // ── Основна функція: пошук і застосування ─────────────────────────────────
    async function searchAndApply(videoParams) {
        // ВИПРАВЛЕННЯ #3: кешуємо card для наступних викликів
        let card = videoParams.movie || videoParams.card;
        if (!card) {
            const active = Lampa.Activity.active();
            if (active) card = active.movie || active.card;
        }
        if (!card && cachedCard) card = cachedCard;
        if (!card) return;

        const kpId = getKpId(card);
        if (!kpId) return;

        const position = (function (params, defaultSeason = 1) {
            if (params.episode || params.e || params.episode_number) {
                return {
                    season:  parseInt(params.season || params.s || defaultSeason),
                    episode: parseInt(params.episode || params.e || params.episode_number),
                };
            }
            if (params.playlist && Array.isArray(params.playlist)) {
                const idx = params.playlist.findIndex(p => p.url && p.url === params.url);
                if (idx !== -1) {
                    const item = params.playlist[idx];
                    return {
                        season:  parseInt(item.season || item.s || defaultSeason),
                        episode: idx + 1,
                    };
                }
            }
            return { season: defaultSeason, episode: 1 };
        })(videoParams, 1);

        let { season, episode } = position;
        const isSerial = card.number_of_seasons > 0 || (card.original_name && !card.original_title);
        if (!isSerial) { season = 1; episode = 1; }

        if (hasExistingSegments(videoParams)) return;

        // Використовуємо кеш якщо той самий серіал, інакше завантажуємо
        let dbData;
        if (kpId === cachedKpId && cachedDbData) {
            dbData = cachedDbData;
        } else {
            dbData = await fetchFromGitHub(kpId);
            if (dbData) {
                cachedKpId   = kpId;
                cachedDbData = dbData;
                cachedCard   = card;
            }
        }
        if (!dbData) return;

        // Застосовуємо до поточного відео
        const segs = getSegmentsFromDb(dbData, season, episode);
        if (segs && segs.length > 0) {
            videoParams.segments = videoParams.segments || {};
            videoParams.segments.skip = segs.slice();
            Lampa.Noty.show("Таймкоди завантажено: Сезон " + season + ", Серія " + episode);
        }

        // Наповнюємо весь плейлист заздалегідь
        if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
            trackedPlaylist = videoParams.playlist;
            populatePlaylist(trackedPlaylist, dbData, season);
        }
    }

    // ── Ініціалізація плагіна ─────────────────────────────────────────────────
    function init() {
        if (window.lampa_series_skip) return;
        window.lampa_series_skip = true;

        const originalPlay     = Lampa.Player.play;
        const originalPlaylist = Lampa.Player.playlist;
        let pendingPlaylist = null;

        Lampa.Player.playlist = function (playlist) {
            pendingPlaylist   = playlist;
            trackedPlaylist   = playlist;
            trackedIndex      = 0;
            originalPlaylist.call(this, playlist);
        };

        Lampa.Player.play = function (videoParams) {
            const context = this;

            if (videoParams.url) Lampa.PlayerPlaylist.url(videoParams.url);
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
                .catch(() => originalPlay.call(context, videoParams));
        };

        // ── ВИПРАВЛЕННЯ #1: перехоплюємо авто-перемикання серій ──────────────
        // Lampa викликає PlayerPlaylist.next() при завершенні відео,
        // що не тригерить наш override Player.play()
        function hookNav(method, delta) {
            const orig = Lampa.PlayerPlaylist[method];
            if (typeof orig !== 'function') return;
            Lampa.PlayerPlaylist[method] = function () {
                trackedIndex = Math.max(0, trackedIndex + delta);
                const result = orig.apply(this, arguments);
                // Невелика затримка: чекаємо поки Lampa оновить внутрішній стан
                setTimeout(() => applyToItemAtIndex(trackedIndex), 150);
                return result;
            };
        }
        hookNav('next', +1);
        hookNav('prev', -1);

        // Додатковий страховий механізм через події плеєра
        Lampa.Listener.follow('player', function (e) {
            if (e.type === 'next' || e.type === 'prev') {
                const delta = e.type === 'next' ? 1 : -1;
                trackedIndex = Math.max(0, trackedIndex + delta);
                setTimeout(() => applyToItemAtIndex(trackedIndex), 150);
            }
        });
    }

    if (window.Lampa && window.Lampa.Player) {
        init();
    } else {
        window.document.addEventListener("app_ready", init);
    }
})();
