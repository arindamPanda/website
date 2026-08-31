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
    const POINTER_RADIUS = 70;  // CSS px
    const EDGE_FADE = 0.08;    // fraction of each axis the outer fade spans
    const NARROW = 420;        // CSS px below which the grid is halved
    const FRAME = 1000 / 30;

    // Full-resolution density, decoded once.
    const fullCols = grid.cols;
    const fullRows = grid.rows;
    const full = new Float32Array(fullCols * fullRows);
    const lines = grid.data.split('\n');
    for (let y = 0; y < fullRows; y++) {
        for (let x = 0; x < fullCols; x++) {
            full[y * fullCols + x] =
                grid.alphabet.indexOf(lines[y][x]) / (grid.levels - 1);
        }
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

    // At mobile widths the full grid renders glyphs too small to read, so fold
    // it 2x2 into a coarser one. The baked grid stays the single source.
    function useGrid(half) {
        if (halved === half) return;
        halved = half;

        cols = half ? Math.floor(fullCols / 2) : fullCols;
        rows = half ? Math.floor(fullRows / 2) : fullRows;
        count = cols * rows;

        target = new Float32Array(count);
        fall = new Float32Array(count);
        delay = new Float32Array(count);
        phase = new Float32Array(count);
        variant = new Float32Array(count);
        comp = new Float32Array(count);
        settled = new Float32Array(count);

        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                const i = y * cols + x;

                if (half) {
                    const sx = x * 2;
                    const sy = y * 2;
                    target[i] = (full[sy * fullCols + sx] +
                        full[sy * fullCols + sx + 1] +
                        full[(sy + 1) * fullCols + sx] +
                        full[(sy + 1) * fullCols + sx + 1]) / 4;
                } else {
                    target[i] = full[i];
                }

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
    }

    // Density means darkness in both themes. On the dark theme that makes the
    // hair the brightest mass — strictly a negative — but the hair is what
    // carries the silhouette: mapping brightness instead correctly drives dark
    // hair to near-empty and the head stops reading at all.
    useGrid(false);

    let cellW = 0;
    let cellH = 0;
    let pxScale = 1;
    let ink = '#45333a';
    let running = false;
    let frameId = 0;
    let start = 0;
    let last = 0;
    const pointer = { x: 0, y: 0, active: false };

    function readInk() {
        const value = getComputedStyle(canvas).getPropertyValue('--ascii-ink').trim();
        if (value) ink = value;
    }

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
        ctx.fillStyle = ink;

        const radius = POINTER_RADIUS * pxScale;
        let lastAlpha = -1;

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
            const noise = 0.5 * opening + idle * (1 - opening);
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

            // Quantise so a run of similar cells shares one state change.
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

    // While running, the next frame picks up the new ink on its own.
    new MutationObserver(() => {
        readInk();
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
