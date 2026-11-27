# Map kit: how pieces meet

Constants live at the top of the walls section in `assets.js`. New pieces follow these rules.

- **Grid.** Buildings, walls, floors, decks and walkways tile on 4 m (`GRID`). Walking surfaces sit at
  multiples of a half storey (`STOREY` 3.5 m), except the low deck (0.5 m) and the riser (1 m). A walkable
  piece's top is its record's `y` (slabs, walkways) or `y + H` (decks). Flights and ramps rise to a deck height
  over a whole number of metres, so on the 1 m snap they land flush on a deck edge. A piece whose edges must
  sit on the 4 m lines and whose size is a multiple of 8 sets `snap: 4, snapOff: 2` (the 8 × 8 deck).
- **Cell widths.** Walkways, decks and full flights are a whole cell (4 m) wide. Half flights are 2 m wide, so
  on the 1 m snap they sit flush against either side of a cell or in its middle, and two of them make a full
  flight. A full-width flight runs into the walls on its cell lines; its rails stand clear of the wall faces.
- **No coplanar faces.** Trims (caps, kicks, bands, frames) and hidden strips stop `INSET` (4 mm) short of any
  face they would otherwise share. For example, under a doorway the wall's foundation or slab-edge strip
  tops out `INSET` below the floor.
- **Corners are owned.** Two runs never overlap at a corner. Each run ends on the corner line, and one piece
  places a post over the corner. Walls get theirs from `buildJoints`. Room walls and roof parapets go to the
  first cell, except at an inside roof corner, where the post goes to the cell across from the gap.
- **Same block, same section, fused.** Plain axis-aligned boxes of one material and one cross-section that
  touch end to end fuse into one box in play (`mapWorld.fuseBoxes`). Faces pressed against other faces are
  dropped (`boxShells`). So keep a run's repeated parts (deck bodies, rails, caps) the same section.
- **Openings report their size.** `wall()` puts `userData.openings` on its group. Each entry comes from
  `opening()`: `clear` is the gap inside the frame (a window's measured from the sill top) and `outer` is what
  the frame and sill take up on the wall. Whatever fills or dresses an opening is cut from these, never from
  hand-tuned numbers: door leaves fill `clear`; shutters hinge on the frame's outer edge (the hole's x0/x1), stand on the sill (`clear.y0`) and reach the head (`y1`), each half the hole wide.
- **Railings end on purpose.** Every rail is built by `railing()`: its rails run exactly between two ends,
  and the piece decides what each end meets. Next to the same railing, the rails meet end to end and one of
  the two pieces owns the post on the joint. Where a parapet ends at that corner, a pier closes the corner
  and the rails die into it. At a wall, they run into its face. Anywhere else, a capped newel post. A piece
  whose ends adapt to its neighbours sets `adapt: true`, so the editor rebuilds it whenever its neighbours
  change.
- **Stairs against walls.** A flight's long sides are checked against every wall run (wall pieces and room
  walls; `wallBeside`, `stairAlong`). A side along a wall gets no rail, because the wall is the guard. A room
  wall with a flight along it goes blank: no window, sign or AC box. A wall piece with a window or door can't
  have a flight along its opening: the editor refuses either one (`wallConflict`).
