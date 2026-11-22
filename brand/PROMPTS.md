# Tess art prompts (copy-paste for Tripo image gen)

Each prompt below works on its own: the character lock is already inside, so you only copy one block.

**How to get Tess consistent**
- If Tripo lets you add a reference image, attach `brand/source/tess-source.png` (or `tess-bust-src.png`) every time.
- Keep the **pure black background**. `tools/make_tess_art.py` cuts her out by keying on black, so the glow survives on any page colour.
- Save the render as `brand/source/tess-<shot>-src.png`, its background-removed copy as `tess-<shot>-cut.png`, then run `.venv/Scripts/python.exe tools/make_tess_art.py` (add the shot to `main()` first).
- Paste the negative prompt into Tripo's negative field if it has one; if not, skip it.

**Negative prompt (all Tess shots)**
```
text, letters, watermark, logo, signature, extra fingers, deformed hands, extra limbs, blurry, lowres, jpeg artifacts, photorealistic, 3d render, gradient background, white background, busy background, scenery, cropped head, multiple girls, nsfw
```

---

## 1. App: empty states and moments

### Library is empty (no assets yet)
`tess-empty` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen tucked behind her ear, black over-ear headphones around her neck, oversized black techwear jacket with high collar and hood, row of silver diamond studs on her left sleeve, sitting cross-legged on the floor, holding one small glowing violet tile in both palms and looking at it with a gentle smile, a few tiny violet pixel squares floating around her, clean cel shading, crisp lineart, violet rim light, pure black background, character on the right third, empty space on the left
```

### First project / onboarding welcome
`tess-welcome` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen tucked behind her ear, black over-ear headphones around her neck, oversized black techwear jacket with high collar and hood, silver diamond studs on her left sleeve, waving hello with one hand raised, warm friendly smile, slight head tilt, a small isometric cube made of violet glowing tiles hovering beside her shoulder, clean cel shading, crisp lineart, violet rim light, pure black background, waist-up, character centered
```

### Onboarding: connect a provider / paste a key
`tess-connect` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, plugging a glowing violet cable into a floating holographic socket, focused expression, tongue slightly out, thin violet light lines connecting tiles in the air, clean cel shading, crisp lineart, violet rim light, pure black background, waist-up, character on the right
```

### Working / generating (loading)
`tess-generating` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black over-ear headphones on her head, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, eyes closed in concentration, both hands spread apart while dozens of violet glowing pixel tiles assemble into a cube between them, motion streaks of violet light, clean cel shading, crisp lineart, strong violet glow, pure black background, waist-up, character centered
```

### Pick a winner (comparing variants)
`tess-pick` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, hand on chin, thinking, three small glowing violet cards floating in front of her, she points at the middle one with her stylus, playful confident smirk, clean cel shading, crisp lineart, violet rim light, pure black background, waist-up, character on the right
```

### Success / asset done
`tess-success` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, cheerful thumbs up and a wink, a finished glowing violet tile cube resting on her other palm, small sparkle pixels bursting around, clean cel shading, crisp lineart, violet rim light, pure black background, waist-up, character centered
```

### Error / something failed
`tess-error` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, sheepish apologetic smile, one hand scratching the back of her head, a violet tile cube beside her has fallen apart into scattered tiles on the ground, clean cel shading, crisp lineart, soft violet rim light, pure black background, waist-up, character centered
```

### Out of credits / budget reached
`tess-budget` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, holding up an empty glass jar with only one dim violet tile at the bottom, mildly pouting expression, one eyebrow raised, clean cel shading, crisp lineart, soft violet rim light, pure black background, waist-up, character centered
```

### Offline / server not reachable
`tess-offline` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones on her head, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, holding a loose unplugged violet cable end and looking at it puzzled, small question-mark shape made of violet pixels above her head, clean cel shading, crisp lineart, soft violet rim light, pure black background, waist-up, character centered
```

### Update ready
`tess-update` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, holding out a small gift box made of violet glowing tiles with a ribbon of light, excited smile, clean cel shading, crisp lineart, violet rim light, pure black background, waist-up, character centered
```

### Idle / waiting for you (sleepy)
`tess-idle` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black over-ear headphones on her head, oversized black techwear jacket with hood up halfway, silver diamond studs on her left sleeve, resting her chin on folded arms, half-closed sleepy eyes, calm smile, a tiny violet tile cube slowly spinning in front of her, clean cel shading, crisp lineart, soft violet rim light, pure black background, chest-up, character centered
```

---

## 2. App: one key art per studio

### Pixel Studio
`tess-pixel` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, drawing in mid-air with her stylus, each stroke leaves crisp square violet pixels that form a small retro pixel-art sword, focused happy expression, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right, empty space on the left
```

### 3D / Tripo Studio (models)
`tess-model` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, turning a floating violet wireframe model of a small treasure chest with two fingers, the wireframe filling in with solid tiles from bottom to top, curious smile, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### Rigs
`tess-rig` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, adjusting a floating glowing violet skeleton rig of a small cute robot, joints shown as bright violet dots connected by thin lines, focused expression, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### Motion Studio (animation)
`tess-motion` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, conducting with her stylus like a baton, a small tile-built figure beside her mid-jump, faint violet ghost frames trailing behind the figure showing its motion, playful grin, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### Sounds
`tess-sound` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black over-ear headphones on her head with one hand pressing an ear cup, eyes closed, listening, blissful smile, violet glowing sound wave bars made of square tiles rising around her, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### Drops
`tess-drops` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, catching small glowing violet tile packages falling from above into an open box she holds, delighted expression, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### Settings
`tess-settings` · 1:1
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, sliding glowing violet slider knobs on a floating translucent control panel, calm professional look, clean cel shading, crisp lineart, violet rim light, pure black background, waist-up, character centered
```

---

## 3. Expression set (chat avatar reactions)

All 1:1, head-and-shoulders, same framing so they swap cleanly. Copy the base, then swap the last part.

```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen tucked behind her ear, black over-ear headphones around her neck, black techwear jacket with high collar, head and shoulders portrait, facing the viewer, clean cel shading, crisp lineart, violet rim light, pure black background, EXPRESSION
```

Replace `EXPRESSION` with one of:
- `happy, closed-eye smile`
- `thinking, looking up, finger on chin`
- `surprised, wide eyes, small open mouth`
- `proud, confident smirk, one eye closed`
- `apologetic, nervous smile, sweat drop`
- `focused, serious eyes, slight frown`
- `laughing, eyes squeezed shut`
- `sleepy, half-closed eyes, small yawn`

---

## 4. Landing page and socials

### Landing hero (alt)
`tess-hero2` · 21:9 (pick 16:9, crop later)
```
anime key visual, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, standing confidently, arms open wide, a huge isometric cube made of violet glowing tiles assembling behind her, small game assets orbiting her (a pixel sword, a tiny robot, a treasure chest, a sound wave), dramatic violet light streaks, clean cel shading, crisp lineart, pure black background, character on the right third, empty space on the left for a headline
```

### "How it works" step art (make 3)
`tess-step-1` / `-2` / `-3` · 4:3
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, STEP, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character centered
```
Replace `STEP` with:
1. `reading a long glowing violet scroll of a game design list, nodding`
2. `drawing a cube in the air, the cube filling with violet tiles`
3. `handing a finished glowing tile cube to the viewer with both hands, smiling`

### Download / call to action
`tess-download` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, leaning forward and pointing down toward the viewer with an encouraging grin, a glowing violet down-arrow made of square tiles beside her, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### 404 page
`tess-404` · 16:9
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, peeking into an empty floating violet tile frame with one missing tile, holding a flashlight that casts a violet beam, curious puzzled face, clean cel shading, crisp lineart, violet glow, pure black background, waist-up, character on the right
```

### Social share card (Open Graph, X, Discord)
`og-image` · 1200x630 (pick 16:9, crop later)
```
anime key visual, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, half-body, smiling at the viewer, holding a glowing isometric cube made of violet tiles with one tile floating above it, violet pixel particles and light streaks, clean cel shading, crisp lineart, deep black background with faint violet vignette, character on the right half, large empty dark area on the left for title text
```

### GitHub / repo banner
`banner` · 3:1 (pick 16:9, crop later)
```
wide anime banner, Tess, a young woman with shoulder-length layered silver-lavender hair, black stylus pen behind her ear, black headphones around her neck, black techwear jacket, lying on her stomach on an invisible floor, chin in hands, kicking her feet, a row of small floating game assets made of violet glowing tiles in front of her, clean cel shading, crisp lineart, violet glow, pure black background, character on the right, long empty space on the left
```

### Windows installer side image
`installer-side` · 164x314 portrait (pick 9:16)
```
anime illustration, Tess, a young woman with shoulder-length layered silver-lavender hair, soft grey eyes, black stylus pen behind her ear, black headphones around her neck, oversized black techwear jacket with hood, silver diamond studs on her left sleeve, full body, standing, looking up at a violet glowing tile cube floating above her raised hand, tall vertical composition, clean cel shading, crisp lineart, violet glow, pure black background, character centered
```

---

## 5. Logo

Image models are bad at spelling. Generate the **mark without text**, then set the word "Tessera" in a font yourself (Inter, Space Grotesk or Sora at 600 weight work with the mark). The existing mark is code-drawn in `tools/make_brand_art.py`; these are for exploring new directions.

**Negative prompt (logo, icon, favicon)**
```
text, letters, words, watermark, photo, realistic, gradient mesh, noise, texture, shadow on background, 3d render clutter, multiple objects, frame, border, mockup, busy background
```

### Primary mark (closest to the current one)
`logo-mark` · 1:1
```
minimal flat vector logo mark, an isometric cube built from 2x2 square tiles on each face with small even gaps between tiles, one tile on the top face lifted and floating above the cube, three tones of violet: light lavender #d9c7ff top face, vivid violet #8a47f5 left face, deep purple #4a2399 right face, the floating tile has a thin white outline, crisp geometric edges, perfectly centered, generous padding, plain solid black background, no text
```

### Mark, alternate: tile becoming a pixel
`logo-mark-alt` · 1:1
```
minimal flat vector logo mark, an isometric cube made of small square tiles, the top corner breaking into a few loose square pixels that drift upward and get smaller, violet palette from #d9c7ff to #3a1c7a, crisp geometric shapes, flat color, no gradients, centered, plain solid black background, no text
```

### Mark, alternate: letter T from tiles
`logo-mark-t` · 1:1
```
minimal flat vector logo mark, a bold letter T shape built from five isometric square tiles, the top-right tile lifting slightly off, three violet tones #d9c7ff #8a47f5 #4a2399, crisp geometric edges, flat color, centered, plain solid black background, no other text
```

### Mark with Tess (mascot logo)
`logo-mascot` · 1:1
```
mascot logo, chibi Tess, a cute girl with short layered silver-lavender hair, black headphones around her neck, black hooded jacket, peeking over the top of an isometric cube made of violet tiles, one tile floating above her head, flat vector style, bold clean outlines, limited palette of black, silver and violet #8a47f5, centered, plain solid black background, no text
```

### Monochrome (for dark/light single-color use)
`logo-mono` · 1:1
```
minimal flat vector logo mark, an isometric cube built from 2x2 square tiles per face with even gaps, one top tile floating above, single color white on solid black background, faces separated only by the gaps between tiles, crisp geometric edges, centered, no text
```

### App icon (desktop / taskbar)
`app-icon` · 1:1
```
app icon, rounded square with a deep black-to-#160b2e background, centered isometric cube built from 2x2 violet tiles per face, light lavender top, vivid violet left, deep purple right, one top tile floating with a soft violet glow under it, flat vector, crisp edges, no text, high contrast, readable at small size
```

---

## 5b. Logo, round 2 (new directions)

Round 1 just redrew the current cube. These go somewhere else. For Nano Banana Pro, **don't** attach the Tess reference here, and pick 1:1 in Tripo's ratio selector.

### A. One mosaic tile ("tessera" means a mosaic tile)
```
Minimal flat vector logo. A single thick square mosaic tile, rotated 8 degrees, with softly rounded corners. Its top-right corner is chipped away in three small square pixel steps, and the missing piece floats just off the corner. Two-tone violet: tile face #8a47f5, a thin lighter bevel #d9c7ff along the top and left edges. Bold, simple, recognisable at 16 pixels. Centered with generous padding on a solid pure black #000000 background. No text, no shadow, no gradient.
```

### B. T monogram in negative space
```
Minimal flat vector logo. A solid violet #8a47f5 rounded square. A bold letter T is cut out of it as negative space, built from three square tiles with thin gaps between them, and the top-right tile of the T is lifted slightly out of the square. Geometric, crisp, works at favicon size. Centered on a solid pure black #000000 background. No other text, no gradient, no shadow.
```

### C. Cube outline, one tile breaking free
```
Minimal line logo. A hexagon silhouette of an isometric cube drawn with one thick even stroke in light lavender #d9c7ff, the inner Y edges drawn the same way. One small solid violet #8a47f5 square tile has broken out of the top face and floats above-right of the hexagon, slightly rotated. Clean geometric strokes, rounded line caps. Centered on a solid pure black #000000 background. No text, no gradient.
```

### D. Stylus and tile (Tess's tool)
```
Minimal flat vector logo. A violet #8a47f5 square tile with a diagonal black stylus nib cutting across it from top-right to bottom-left, the nib tip leaving three tiny square pixels behind it. Bold shapes, high contrast, two colours plus black. Centered on a solid pure black #000000 background. No text, no gradient.
```

### E. Wordmark (Nano Banana Pro can spell)
```
Wordmark logo reading exactly "Tessera" in a clean geometric sans-serif, semibold, white #f1e9ff, generous letter spacing. The crossbar of the T is a small violet #8a47f5 square tile lifted a little above the stem. Everything else plain. Horizontal layout, centered on a solid pure black #000000 background, no other text, no tagline.
```

---

## 5c. Redos (round 1 misses)

Tripo only offers 1:1, 16:9, 9:16, 4:3 and 3:4. Generate at the closest one (in brackets below) and crop afterwards: the background is pure black, so cropping or padding leaves no seam.

### Landing hero (she came out tiny and centered)
`tess-hero2` · 21:9 (pick 16:9, crop later)
```
Same character as the reference image. Ultra-wide 21:9 cinematic key visual. Tess fills the right third of the frame, framed from mid-thigh up, her head near the top edge, arms open wide, confident smile. Behind her a huge isometric cube made of violet glowing tiles assembles itself, and small game assets orbit her: a pixel sword, a tiny robot, a treasure chest, a sound wave. Violet light streaks. The left half of the frame is empty black for a headline. 2D anime cel-shaded illustration, crisp lineart, flat colors, not 3D. Solid pure black #000000 background, no gradient, no vignette, no text.
```

### Welcome (came out on white)
`tess-welcome` · 16:9
```
Same character as the reference image. Tess waves hello with one hand raised, warm friendly smile, slight head tilt, a small isometric cube of violet glowing tiles hovering by her shoulder. Waist-up, centered. 2D anime cel-shaded illustration, crisp lineart, violet rim light, not 3D. Solid pure black #000000 background, no gradient, no white, no text.
```

### Repo banner (came out 16:9)
`banner` · 3:1 (pick 16:9, crop later)
```
Same character as the reference image. Very wide 3:1 banner. Tess lies on her stomach on an invisible floor at the right end of the frame, chin in her hands, feet kicked up, smiling. A long row of small floating game assets made of violet glowing tiles stretches across the middle toward the left. The left 60 percent is mostly empty black. 2D anime cel-shaded illustration, crisp lineart, not 3D. Solid pure black #000000 background, no gradient, no text.
```

### Installer side image (missing)
`installer-side` · 1:2 portrait (pick 9:16)
```
Same character as the reference image. Tall narrow vertical portrait. Tess full body, standing, looking up at a violet glowing tile cube floating above her raised hand, a few pixel tiles drifting upward. She fills the lower two-thirds, the cube near the top. 2D anime cel-shaded illustration, crisp lineart, violet glow, not 3D. Solid pure black #000000 background, no gradient, no text.
```

---

## 6. Favicon

At 16 to 32 px detail vanishes, so the favicon keeps only the cube silhouette and the floating tile. Generate big, then downscale (or let `tools/make_brand_art.py` rebuild it from the SVG, which is sharper).

### Favicon (full)
`favicon` · 1:1, export 32x32 and 16x16
```
favicon icon, extremely simple flat isometric cube with three solid faces, light lavender #d9c7ff top, vivid violet #8a47f5 left, deep purple #4a2399 right, one small square tile floating just above the top face, thick bold shapes, no thin lines, no gaps, no gradients, centered, fills most of the canvas, transparent or solid black background, no text
```

### Favicon (tiniest, 16 px)
`favicon-16` · 1:1
```
Pixel art icon on a 16 by 16 grid, drawn large with every pixel a clear hard square. A hexagon-shaped isometric cube: top face light lavender #d9c7ff, left face violet #8a47f5, right face deep purple #4a2399, with a one-pixel black outline. A single 2 by 2 lavender pixel block floats above the top face with one black pixel row of gap. No anti-aliasing, no gem shape, no rounded sphere. Solid pure black #000000 background, no text.
```

Honestly, the best favicon is whichever logo wins in 5b, shrunk down. Pick the logo first, then make the favicon from it.

---

## 7. Landing, grey-cube hero (Nano Banana Pro)

Attach the Tess reference for both. The hero now shows a grey placeholder cube breaking into tiles around the finished asset, so the cube Tess holds is **grey**, not violet.

### Level builder card (the only studio card without Tess)
`tess-level` · 16:9 → cut to `docs/landing/tess/level.webp`
```
Same character as the reference image. Tess, waist-up, on the right third of the frame, leaning over a small floating isometric city block made of pastel toy buildings with neon signs, placing one last building on it with two fingers, a few loose building blocks and street props floating around her hand, pleased focused smile. Soft blue rim light, hex #5a8cff, on her and on the block. 2D anime cel-shaded illustration, crisp lineart, flat colours, not 3D. Solid pure black #000000 background, no gradient, no vignette, no text. Empty black space on the left.
```

### Social share card, matching the new hero
`og-image` · 16:9, crop to 1200x630
```
Same character as the reference image. Tess, half-body on the right half of the frame, smiling at the viewer, one open palm held out toward the left. Above her palm floats a plain matte grey cube with a faint checkerboard pattern, like a game engine placeholder. The cube is breaking apart: its grey tiles fly outward and turn into glowing violet glass shards, and from inside it rises a small chubby pastel-pink baby kaiju with cream back spikes and big sparkling violet eyes, lit from within. Violet light on Tess's hand and face. 2D anime cel-shaded illustration, crisp lineart, not 3D. Deep black background with a faint violet vignette, large empty dark area on the left for title text, no text.
```
