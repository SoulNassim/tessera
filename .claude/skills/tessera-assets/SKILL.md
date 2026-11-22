---
name: tessera-assets
description: For agents coding a game against Tessera, the asset studio. Copy finished art, 3D models, rigs, animations and sounds from the game's tessera/ folder into the game, using tessera/ASSETS.md, and keep placeholders for anything still missing.
---

# Tessera asset loop

Use this when you are coding a game and need art, 3D models, animations or sounds. The user makes them in Tessera. You copy the finished files into the game.

Tessera's project for this game is in `tessera/` in the game folder. Its index, `tessera/ASSETS.md`, lists every asset: name, kind, page, the picked image or sound (`winner:`), any 3D model, rig and animation files, and how to place each model (height, scale, front, named points). If `tessera/ASSETS.md` is missing, Tessera isn't set up for this game yet: see `docs/agent.md`.

## The loop

1. **Use a placeholder** in your code for any asset that isn't made yet.
2. **Read `tessera/ASSETS.md`** and find the asset you need.
3. **Copy the files into the game**: the picked image or sound (`winner:`), plus any 3D model, rig or animation files, into the game's own folders. Point your code at the copies.
4. **Place 3D models with the row's "Size and placement"**: scale the model by `scale` to get its real height in metres, turn it so its `front` axis faces where its front should, and put things on its named points (`ground`, `top`, and ones the user clicked, like `light` or `grip`). A rig lists its bone points (`head`, `hand_l`, `hand_r`, `foot_l`, `foot_r`) and each clip says loop or once. Points are in the model's own units: scale and turn them with it. "not checked" means a default, so look at it in the game. The same data is in `tessera/ASSETS.json` for code.
5. **Pixel sprites**: a row may list "pixel sprites" (frame size, facings, and each animation with frames, fps and loop). Use the exported sheet: `sheet.png` with `sheet.json` (Aseprite format, one tag per animation and facing, like `walk_s`) for any engine, or the Godot `.tres` SpriteFrames next to it. Copy the sheet and the file you use together. If it says "not exported yet", ask the user to press Export in Tessera's Pixel Studio.
6. **Use the icon** listed under Other files for inventories and menus: square, transparent and cropped the same way for every asset.
7. **Keep the placeholder for anything missing** and add a line to `tessera/REQUESTS.md` (see below). Sounds have no 3D model: "sound ready" means the picked sound is the file.

When a winner changes in Tessera, copy it again. Tessera checks the game's files against its own: if `tessera/ASSETS.md` has a section "Copies in the game that are out of date", copy the listed new file over each one. In `tessera/ASSETS.json` each asset's `in_game` lists the copies it found (`current`, `stale` or `edited`).

## Asking for art: tessera/REQUESTS.md

`tessera/REQUESTS.md` is the one file in `tessera/` you may write. Keep a checklist there of what the game still needs, one line each, specific about size, front and points:

```markdown
- [ ] Stone Altar: new prop, 2.5 m tall, front +Z, point `offering` on top
- [ ] Crewmate: taller and slimmer, about 1.8 m
- [ ] Lantern Post: add point `light` where the lantern hangs
```

Tessera shows the list to the user, who decides what gets made. Tick a line (`- [x]`) once its art shows up in `tessera/ASSETS.md`.

## Levels from modular kits

A `kit` asset in `tessera/ASSETS.md` comes with a `kit.json` next to its GLB. Read it before writing level code: it gives the grid, how to place and turn each piece, what each side connects to, and a sample room to check your placement against. Copy the GLB and `kit.json` together. A `material` asset has tiling maps (albedo, normal, roughness, height, orm) for any surface in the game.

## Rules

- Never edit, move or delete anything inside `tessera/`, except `tessera/REQUESTS.md`. Tessera owns that folder.
- Making, picking and sorting art happens in Tessera, not here.
- Write only to the game's own folders and `tessera/REQUESTS.md`, nowhere else inside `tessera/`.
