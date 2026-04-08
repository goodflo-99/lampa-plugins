(function () {
    "use strict";

    const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";

    // ── Стан між серіями ──────────────────────────────────────────────────────
    let cachedKpId    = null;
    let cachedDbData  = null;
    let cachedCard    = null;
    let cachedSeason  = 1;
    let trackedPlaylist     = null;
    let trackedStartEpisode = 1;

    // ── Утиліти ───────────────────────────────────────────────────────────────
    function hasExistingSegments(obj) {
        return obj && obj.segments && obj.segments.skip && obj.segments.skip.length > 0;
    }

    function getSegmentsFromDb(dbData, season, episode) {
        if (!dbData) return null;
        const s = String(season), e = String(episode);
        if (dbData[s] && dbData[s][e]) return dbData[s][e];
        if (s === "1" && e === "1" && dbData.movie) return dbData.movie;
        if (dbData.movie) return dbData.movie;
        return null;
    }

    async function fetchFromGitHub(kpId) {
        try {
            const resp = await fetch(`${GITHUB_DB_URL}${kpId}.json`);
            return resp.ok ? await resp.json() : null;
        } catch (e) { return null; }
    }

    // Розраховуємо початковий номер серії (для плейлистів середини сезону)
    function calcStartEpisode(playlist) {
        if (!playlist || !playlist.length) return 1;
        for (let i = 0; i < playlist.length; i++) {
            const ep = parseInt(playlist[i].episode || playlist[i].e || playlist[i].episode_number);
            if (ep > 0) return Math.max(1, ep - i);
        }
        return 1;
    }

    // Визначаємо поточну позицію (сезон/серія) з різних джерел
    function detectPosition(params) {
        // Пріоритет 1: явні поля episode/season на videoParams
        if (params.episode || params.e || params.episode_number) {
            return {
                season:  parseInt(params.season  || params.s  || cachedSeason || 1),
                episode: parseInt(params.episode || params.e  || params.episode_number),
            };
        }
        // Пріоритет 2: пошук URL у playlist (videoParams або trackedPlaylist)
        const playlist = (params.playlist && Array.isArray(params.playlist) ? params.playlist : null)
                      || trackedPlaylist;
        if (playlist && params.url) {
            const idx = playlist.findIndex(p => typeof p.url === 'string' && p.url === params.url);
            if (idx !== -1) {
                const item    = playlist[idx];
                const startEp = calcStartEpisode(playlist);
                return {
                    season:  parseInt(item.season || item.s || cachedSeason || 1),
                    episode: parseInt(item.episode || item.e || item.episode_number) || (startEp + idx),
                };
            }
        }
        return { season: cachedSeason || 1, episode: 1 };
    }

    // Синхронно отримує сегменти з кешу для конкретного item + index
    function getSegsForItem(item, index) {
        if (!cachedDbData) return null;
        const s  = parseInt(item.season || item.s || cachedSeason || 1);
        const ep = parseInt(item.episode || item.e || item.episode_number)
                || (trackedStartEpisode + index);
        return getSegmentsFromDb(cachedDbData, s, ep) || null;
    }

    // ── Основна функція ───────────────────────────────────────────────────────
    async function searchAndApply(videoParams) {
        let card = videoParams.movie || videoParams.card;
        if (!card) {
            try { const a = Lampa.Activity.active(); if (a) card = a.movie || a.card; } catch (e) {}
        }
        if (!card && cachedCard) card = cachedCard;
        if (!card) return;

        const kpId = card.kinopoisk_id || (card.source === "kinopoisk" ? card.id : null) || card.kp_id;
        if (!kpId) return;

        const { season, episode } = detectPosition(videoParams);
        cachedSeason = season;

        const isSerial = card.number_of_seasons > 0 || (card.original_name && !card.original_title);
        const s = isSerial ? season : 1;
        const e = isSerial ? episode : 1;

        if (hasExistingSegments(videoParams)) return;

        let dbData;
        if (kpId === cachedKpId && cachedDbData) {
            dbData = cachedDbData;
        } else {
            dbData = await fetchFromGitHub(kpId);
            if (dbData) { cachedKpId = kpId; cachedDbData = dbData; cachedCard = card; }
        }
        if (!dbData) return;

        const segs = getSegmentsFromDb(dbData, s, e);
        if (segs && segs.length > 0) {
            videoParams.segments = { skip: segs.slice() };
            Lampa.Noty.show("Таймкоди: Сезон " + s + ", Серія " + e);
        }

        // Попередньо наповнюємо всі серії плейлиста
        const list = (videoParams.playlist && Array.isArray(videoParams.playlist))
            ? videoParams.playlist : trackedPlaylist;
        if (list) {
            if (videoParams.playlist) {
                trackedPlaylist     = videoParams.playlist;
                trackedStartEpisode = calcStartEpisode(trackedPlaylist);
            }
            list.forEach((item, idx) => {
                if (hasExistingSegments(item)) return;
                const itemSegs = getSegsForItem(item, idx);
                if (itemSegs && itemSegs.length > 0) item.segments = { skip: itemSegs.slice() };
            });
        }
    }

    // ── Ключове виправлення: синхронне застосування в next()/prev() ───────────
    // Lampa не викликає Player.play() при авто-переході → перехоплюємо тут
    function applyBeforeNav(targetIndex) {
        if (!cachedDbData || !trackedPlaylist) return;
        const item = trackedPlaylist[targetIndex];
        if (!item) return;
        // Перезаписуємо навіть якщо сегменти вже є (могли залишитись від попередньої серії)
        const segs = getSegsForItem(item, targetIndex);
        if (segs && segs.length > 0) {
            item.segments = { skip: segs.slice() };
        } else {
            // Немає таймкодів — очищаємо, щоб не залишились від попередньої серії
            if (item.segments) delete item.segments;
        }
    }

    function init() {
        if (window.lampa_series_skip) return;
        window.lampa_series_skip = true;

        const originalPlay     = Lampa.Player.play;
        const originalPlaylist = Lampa.Player.playlist;
        let pendingPlaylist = null;

        Lampa.Player.playlist = function (playlist) {
            pendingPlaylist = playlist;
            if (playlist && Array.isArray(playlist)) {
                trackedPlaylist     = playlist;
                trackedStartEpisode = calcStartEpisode(playlist);
            }
            originalPlaylist.call(this, playlist);
        };

        Lampa.Player.play = function (videoParams) {
            const context = this;
            if (videoParams.url) Lampa.PlayerPlaylist.url(videoParams.url);
            if (videoParams.playlist && videoParams.playlist.length > 0)
                Lampa.PlayerPlaylist.set(videoParams.playlist);

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

        // ── Перехоплення next()/prev() ─────────────────────────────────────────
        // Застосовуємо сегменти СИНХРОННО ДО виклику оригінального next/prev,
        // щоб item.segments вже були встановлені, коли плеєр бере наступний елемент
        function hookNav(method) {
            const orig = Lampa.PlayerPlaylist[method];
            if (typeof orig !== 'function') return;

            Lampa.PlayerPlaylist[method] = function () {
                if (cachedDbData && trackedPlaylist) {
                    // Знаходимо індекс поточного елементу (позначений selected:true)
                    let curIdx = trackedPlaylist.findIndex(i => i.selected);
                    if (curIdx < 0) {
                        // Запасний варіант: пошук за URL поточного відео
                        try {
                            const curUrl = Lampa.Player.video && Lampa.Player.video.src;
                            if (curUrl) curIdx = trackedPlaylist.findIndex(i => i.url === curUrl);
                        } catch (e) {}
                    }

                    const delta    = method === 'next' ? 1 : -1;
                    const targetIdx = curIdx >= 0
                        ? curIdx + delta
                        : (method === 'next' ? 0 : trackedPlaylist.length - 1);

                    applyBeforeNav(targetIdx);
                }
                return orig.apply(this, arguments);
            };
        }
        hookNav('next');
        hookNav('prev');

        // ── Додатковий рівень: події плеєра ───────────────────────────────────
        Lampa.Listener.follow('player', function (e) {
            if (e.type === 'next' || e.type === 'prev') {
                // Якщо play() все ж викликається — searchAndApply обробить через кеш
                // Якщо ні — hookNav вже застосував сегменти
            }
            // Проактивне застосування: коли серія закінчилась, готуємо наступну
            if (e.type === 'ended' && trackedPlaylist && cachedDbData) {
                const curIdx = trackedPlaylist.findIndex(i => i.selected);
                if (curIdx >= 0) applyBeforeNav(curIdx + 1);
            }
        });
    }

    if (window.Lampa && window.Lampa.Player) {
        init();
    } else {
        window.document.addEventListener("app_ready", init);
    }
})();
