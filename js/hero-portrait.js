/* Hero portrait as a field of monospace glyphs: starts as static, denoises into
   the portrait, then keeps shimmering. Density grid comes from js/portrait-grid.js
   (baked by tools/ascii_portrait.py). */
(() => {
    const canvas = document.querySelector('.hero-ascii');
    const grid = window.PORTRAIT_GRID;
    if (!canvas || !grid) return;

    const ctx = canvas.getContext('2d');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

    // Busy alphabet while a cell is unresolved. The settled ramp is baked with
    // the grid, ordered by measured ink coverage, and has no blank at its low
    // end so background cells keep a faint glyph — the portrait emerges out of
    // a live character field rather than empty space.
    const NOISE = '{%^R#j?K&8Wq!/z~9|Gv3@$m<_Xb2';
    // Every settled cell draws from this one pool and conveys its tone through
    // opacity instead of glyph weight — see tools/ascii_portrait.py. Members all
    // lay down near-identical ink, so the choice is free of tonal consequence.
    const POOL = grid.pool || '=><|?ilc[]vLjz7x*t{}fsTJY1CunyFI2oe3wVhk%5Za4SXP$E';
    // Relative ink of each pool glyph, same order. Pool members still vary ~1.85x
    // in coverage, so without correcting for it the random pick would swamp the
    // portrait's modelling with brightness jitter.
    const WEIGHTS = grid.weights || [];

    // Opacity is now the only tonal signal, so it has to carry the range glyph
    // coverage used to supply as well. The low floor widens it and the exponent
    // restores shadow depth; raise if the portrait looks flat, lower if the
    // shadows crush and the face loses modelling.
    const TONE_CURVE = 1.7;

    const SETTLE = 0.3;        // seconds for one cell to resolve
    const ENTRANCE = 1.6;      // seconds until the whole field has resolved
    const SHIMMER_RATE = 0.03; // fraction of cells re-noised each frame
    const CALM_ABOVE = 0.45;   // denser than this and the cell stops flickering
    // Idle noise is otherwise a multiple of the cell's own tone, which leaves the
    // backdrop — over a third of this frame — swinging 0.041 to 0.058 alpha as it
    // churns: it flickers, but far too faintly to see, so the field reads frozen.
    // This adds a flat lift on top, scaled by (1 - density) so it lands almost
    // entirely on the faint cells and leaves the portrait's tone alone.
    const SPARKLE = 0.06;
    // Colour buckets between --ascii-ink-low and --ascii-ink. Quantised so a run
    // of similar cells shares one fillStyle, the same trick the alpha uses.
    const RAMP_STEPS = 24;
    // Unresolved cells draw in one fixed shade rather than their own: mid-shimmer
    // static is not part of the portrait and must not spoil its tone. Held well
    // down the ramp because a wall of full-brightness light ink on a dark page is
    // glare, where the same wall of dark ink on cream reads as texture.
    const NOISE_SHADE = (RAMP_STEPS * 0.35) | 0;
    // How bright the opening wall of static is. Same reason: light ink on a dark
    // page carries much further, so the entrance has to be pitched lower or it
    // whites out the hero for its first half second.
    const WALL_LIGHT = 0.5;
    const WALL_DARK = 0.28;
    const POINTER_RADIUS = 70;  // CSS px
    const EDGE_FADE = 0.08;    // fraction of each axis the outer fade spans
    const NARROW = 420;        // CSS px below which the grid is halved
    const FRAME = 1000 / 30;

    // Full-resolution density, decoded once per theme channel. The two are the
    // same portrait with the tone inverted: ink has to mean "far from the page",
    // which is the shadows on cream and the highlights on brown. Sharing one
    // channel renders the dark theme as a negative — hair the brightest mass,
    // face a hollow. dataDark is optional so an older baked grid still runs.
    const fullCols = grid.cols;
    const fullRows = grid.rows;

    function decode(text) {
        const out = new Float32Array(fullCols * fullRows);
        const lines = text.split('\n');
        for (let y = 0; y < fullRows; y++) {
            for (let x = 0; x < fullCols; x++) {
                out[y * fullCols + x] =
                    grid.alphabet.indexOf(lines[y][x]) / (grid.levels - 1);
            }
        }
        return out;
    }

    const fullLight = decode(grid.data);
    const fullDark = grid.dataDark ? decode(grid.dataDark) : fullLight;
    // Tone as colour, for the dark theme only — see the dark block in the
    // generator. Absent on an older baked grid, in which case tinting is off and
    // every cell draws in the flat ink.
    const fullTint = grid.dataTint ? decode(grid.dataTint) : null;
    let full = fullLight;

    function isDark() {
        return document.documentElement.dataset.theme === 'dark';
    }

    function tinting() {
        return fullTint !== null && isDark();
    }

    let cols = 0;
    let rows = 0;
    let count = 0;
    let halved = null;
    let target;   // ink density, 0..1
    let fall;     // radial falloff into the page
    let delay;    // entrance stagger, seconds
    let phase;    // per-cell wobble offset
    let variant;  // per-cell pick from the glyph pool
    let comp;     // per-cell opacity correction for that glyph's ink
    let settled;  // resolve progress, 0..1
    let tint;     // per-cell colour bucket, index into RAMP
    let tintRaw;  // float scratch the tint buckets are quantised from

    // Fold the full-resolution channel into the active grid, averaging 2x2 when
    // halved. Both channels go through this so colour and opacity always share a
    // footprint.
    function sample(src, out) {
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;
                if (halved) {
                    const sx = x * 2;
                    const sy = y * 2;
                    out[i] = (src[sy * fullCols + sx] +
                        src[sy * fullCols + sx + 1] +
                        src[(sy + 1) * fullCols + sx] +
                        src[(sy + 1) * fullCols + sx + 1]) / 4;
                } else {
                    out[i] = src[i];
                }
            }
        }
    }

    // Re-read the active channels. Only these depend on the theme — the geometry,
    // stagger and glyph picks are all channel-independent, so a theme switch
    // re-tones the portrait in place without disturbing its entrance progress or
    // making it re-pick every glyph.
    function fillTarget() {
        sample(full, target);
        if (tinting()) {
            // Via the float scratch, not straight into tint: that is a Uint8Array
            // and would truncate every 0..1 sample to zero.
            sample(fullTint, tintRaw);
            for (let i = 0; i < count; i++) {
                tint[i] = Math.min(RAMP_STEPS - 1, (tintRaw[i] * RAMP_STEPS) | 0);
            }
        } else {
            // Flat ink: every cell lands on the top of the ramp, which readInk
            // pins to --ascii-ink itself, so the light theme draws exactly as it
            // did before tinting existed.
            tint.fill(RAMP_STEPS - 1);
        }
    }

    // At mobile widths the full grid renders glyphs too small to read, so fold
    // it 2x2 into a coarser one. The baked grid stays the single source.
    function useGrid(half) {
        if (halved === half) return;
        halved = half;

        cols = half ? Math.floor(fullCols / 2) : fullCols;
        rows = half ? Math.floor(fullRows / 2) : fullRows;
        count = cols * rows;

        target = new Float32Array(count);
        tint = new Uint8Array(count);
        tintRaw = new Float32Array(count);
        fall = new Float32Array(count);
        delay = new Float32Array(count);
        phase = new Float32Array(count);
        variant = new Float32Array(count);
        comp = new Float32Array(count);
        settled = new Float32Array(count);

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;

                // The whole frame renders; only the outermost cells soften, so
                // the block dissolves into the page instead of ending on a
                // hard line. Distance to the nearest edge, not to the centre.
                const edge = Math.min(
                    Math.min(x + 0.5, cols - 0.5 - x) / cols,
                    Math.min(y + 0.5, rows - 0.5 - y) / rows);
                const e = Math.min(1, edge / EDGE_FADE);
                fall[i] = e * e * (3 - 2 * e);

                // Kept radial, and deliberately independent of the fade above:
                // this is what makes the centre resolve first and read as
                // diffusion rather than a plain wipe.
                const dx = (x + 0.5) / cols - 0.5;
                const dy = (y + 0.5) / rows - 0.5;
                const d = Math.min(1, Math.hypot(dx, dy) * 2);

                delay[i] = d * (ENTRANCE - SETTLE) * 0.65 +
                    Math.random() * (ENTRANCE - SETTLE) * 0.35;
                phase[i] = Math.random() * Math.PI * 2;
                // Chosen once, not per frame, so the portrait holds still —
                // which also makes the ink correction a per-cell constant.
                variant[i] = Math.random();
                comp[i] = 1 / (WEIGHTS[(variant[i] * POOL.length) | 0] || 1);
            }
        }

        fillTarget();
    }

    let cellW = 0;
    let cellH = 0;
    let pxScale = 1;
    let ink = '#45333a';
    let ramp = [];
    let running = false;
    let frameId = 0;
    let start = 0;
    let last = 0;
    const pointer = { x: 0, y: 0, active: false };

    // #rgb / #rrggbb only. Anything else returns null and the ramp collapses to
    // the flat ink, which is exactly the pre-tinting rendering — a bad custom
    // property degrades to the old look rather than to an invisible portrait.
    function parseHex(value) {
        const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
        if (!m) return null;
        const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
        return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
    }

    function readInk() {
        const style = getComputedStyle(canvas);
        const value = style.getPropertyValue('--ascii-ink').trim();
        if (value) ink = value;

        const hi = parseHex(ink);
        const lo = parseHex(style.getPropertyValue('--ascii-ink-low').trim());
        ramp = [];
        for (let s = 0; s < RAMP_STEPS; s++) {
            if (!hi || !lo) { ramp.push(ink); continue; }
            const t = s / (RAMP_STEPS - 1);
            const c = lo.map((v, k) => Math.round(v + (hi[k] - v) * t));
            ramp.push(`rgb(${c[0]},${c[1]},${c[2]})`);
        }
    }

    readInk();
    full = isDark() ? fullDark : fullLight;
    useGrid(false);

    function fit() {
        // Proportions follow the baked image, so swapping the photo needs only
        // a generator re-run. The CSS value is just the pre-JS default.
        if (grid.aspect) canvas.style.aspectRatio = grid.aspect;

        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return false;

        useGrid(w < NARROW);

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        cellW = canvas.width / cols;
        cellH = canvas.height / rows;
        pxScale = canvas.width / w;

        // Keep the glyph inside its cell: monospace advance is ~0.6em.
        const size = Math.min(cellH, cellW / 0.6);
        ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        return true;
    }

    function draw(elapsed) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const radius = POINTER_RADIUS * pxScale;
        let lastAlpha = -1;
        let lastTint = -1;
        const tinted = tinting();
        const wall = tinted ? WALL_DARK : WALL_LIGHT;
        const noiseShade = tinted ? NOISE_SHADE : RAMP_STEPS - 1;

        // The entrance wants a bright wall of static; idle shimmer must not,
        // or every flickering backdrop cell outshines the portrait. Fade the
        // noise brightness from absolute to a multiple of the cell's own.
        const opening = Math.max(0, 1 - elapsed / ENTRANCE);

        for (let i = 0; i < count; i++) {
            let p = settled[i];
            const cx = (i % cols + 0.5) * cellW;
            const cy = ((i / cols) | 0) * cellH + cellH * 0.5;

            if (pointer.active) {
                const d = Math.hypot(cx - pointer.x, cy - pointer.y);
                if (d < radius) p = Math.min(p, d / radius);
            }

            const density = target[i];
            const resolved = 0.04 + 0.96 * Math.pow(density, TONE_CURVE);
            // Breathing fades out over the portrait so the face stays readable.
            const wobble = 1 + 0.16 * (1 - density) * Math.sin(elapsed * 1.7 + phase[i]);
            const idle = resolved * 1.4 + SPARKLE * (1 - density);
            const noise = wall * opening + idle * (1 - opening);
            // comp corrects for the settled glyph's ink; cells drawing from
            // NOISE mid-shimmer are transient static and are meant to flicker.
            let alpha = fall[i] * (noise + (resolved - noise) * p) * wobble * comp[i];
            if (alpha < 0.03) continue;
            if (alpha > 1) alpha = 1;

            // Settled cells hold the glyph their variant picked; unsettled ones
            // re-pick every frame, which is what still reads as static.
            const ch = Math.random() < p
                ? POOL[(variant[i] * POOL.length) | 0]
                : NOISE[(Math.random() * NOISE.length) | 0];

            // Quantise so a run of similar cells shares one state change. A cell
            // still resolving shows its noise glyph in the flat ink: mid-shimmer
            // static is not part of the portrait and should not wear its tone.
            const shade = p > 0.5 ? tint[i] : noiseShade;
            if (shade !== lastTint) {
                ctx.fillStyle = ramp[shade];
                lastTint = shade;
            }
            const step = Math.round(alpha * 32) / 32;
            if (step !== lastAlpha) {
                ctx.globalAlpha = step;
                lastAlpha = step;
            }
            ctx.fillText(ch, cx, cy);
        }

        ctx.globalAlpha = 1;
    }

    function advance(dt, elapsed) {
        for (let i = 0; i < count; i++) {
            if (elapsed < delay[i]) continue;
            settled[i] = Math.min(1, settled[i] + dt / SETTLE);
        }

        // Once the field has resolved, keep knocking a few cells back so it
        // never looks frozen.
        if (elapsed > ENTRANCE) {
            const n = (count * SHIMMER_RATE) | 0;
            for (let k = 0; k < n; k++) {
                const i = (Math.random() * count) | 0;
                // Churn the backdrop, leave the portrait alone: anything dense
                // holds still, and the rest flickers less the denser it is.
                if (target[i] > CALM_ABOVE) continue;
                if (Math.random() < target[i]) continue;
                if (settled[i] > 0.15) settled[i] = 0.15;
            }
        }
    }

    function tick(now) {
        frameId = requestAnimationFrame(tick);
        if (now - last < FRAME) return;

        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        const elapsed = (now - start) / 1000;

        advance(dt, elapsed);
        draw(elapsed);
    }

    function drawStatic() {
        // fit() may swap in a different grid, so settle after it, not before.
        if (!fit()) return;
        settled.fill(1);
        draw(0);
    }

    function play() {
        if (running || reduceMotion.matches) return;
        if (!fit()) return;
        running = true;
        start = performance.now() - start;
        last = performance.now();
        frameId = requestAnimationFrame(tick);
    }

    function pause() {
        if (!running) return;
        running = false;
        start = performance.now() - start;
        cancelAnimationFrame(frameId);
    }

    canvas.addEventListener('pointermove', (e) => {
        if (reduceMotion.matches) return;
        const rect = canvas.getBoundingClientRect();
        pointer.x = (e.clientX - rect.left) * pxScale;
        pointer.y = (e.clientY - rect.top) * pxScale;
        pointer.active = true;
    });

    canvas.addEventListener('pointerleave', () => {
        pointer.active = false;
    });

    // Covers scrolling away and the display:none case when another panel is active.
    new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            reduceMotion.matches ? drawStatic() : play();
        } else {
            pause();
        }
    }).observe(canvas);

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) pause();
        else if (!reduceMotion.matches) play();
    });

    // While running, the next frame picks up the new ink and tone on its own.
    new MutationObserver(() => {
        readInk();
        const next = isDark() ? fullDark : fullLight;
        if (next !== full) {
            full = next;
            fillTarget();
        }
        if (!running && reduceMotion.matches) drawStatic();
    }).observe(document.documentElement, { attributeFilter: ['data-theme'] });

    reduceMotion.addEventListener('change', () => {
        if (reduceMotion.matches) {
            pause();
            drawStatic();
        } else {
            play();
        }
    });

    let resizeId = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeId);
        resizeId = setTimeout(() => {
            if (running) fit();
            else if (reduceMotion.matches) drawStatic();
        }, 150);
    });

    readInk();
    if (reduceMotion.matches) drawStatic();
})();
