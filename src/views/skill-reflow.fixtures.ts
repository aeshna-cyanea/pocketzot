// Skill-menu CRT lines captured verbatim off the wire from a real crawl binary,
// so the tests measure the real fixed-width grid rather than a hand-drawn
// approximation of it.
//
// The grid's geometry is what the reflow is built on: each cell is 39 columns
// wide, the left one starts at column 1 and the right one at column 40, and the
// header row names both. Every line below obeys that. To re-capture, open the
// skill menu (`m`) and read the raw CRT lines handed to reflowSkillCrt.

// A Human Fighter, "training" view: lettered rows, one lone right-column skill
// (Spellcasting), blank separators between skill groups, and a trailing blank
// strip padding the grid out above the help text.
export const HUMAN_TRAIN: string[] = [
  "      <span class=\"fg1 bg0\">Skill           Level Train  Apt       Skill           Level Train  Apt",
  "  <span class=\"fg7 bg0\">a + Fighting         3.0  </span><span class=\"fg6 bg0\">31%     </span><span class=\"fg15 bg0\">0    </span><span class=\"fg8 bg0\">j + Spellcasting     0.0         </span><span class=\"fg15 bg0\">-1",
  "",
  "  <span class=\"fg10 bg0\">b + Maces &amp; Flails   1.1          </span><span class=\"fg15 bg0\">0",
  "  <span class=\"fg7 bg0\">c + Axes             2.0   </span><span class=\"fg6 bg0\">8%     </span><span class=\"fg15 bg0\">0",
  "  <span class=\"fg10 bg0\">d + Polearms         1.1          </span><span class=\"fg15 bg0\">0",
  "  <span class=\"fg8 bg0\">e + Unarmed Combat   0.0          </span><span class=\"fg15 bg0\">0",
  "",
  "",
  "  <span class=\"fg7 bg0\">f + Armour           3.0  </span><span class=\"fg6 bg0\">31%     </span><span class=\"fg15 bg0\">0",
  "  <span class=\"fg8 bg0\">g + Dodging          0.0          </span><span class=\"fg15 bg0\">0",
  "  <span class=\"fg7 bg0\">h + Shields          3.0  </span><span class=\"fg6 bg0\">30%     </span><span class=\"fg15 bg0\">0",
  "  <span class=\"fg8 bg0\">i + Stealth          0.0         </span><span class=\"fg15 bg0\">+1",
  "",
  "",
  "",
  "",
  "",
  " <span class=\"fg7 bg0\">The percentage of incoming experience used to train each skill is in </span><span class=\"fg6 bg0\">brown</span><span class=\"fg7 bg0\">.",
  " <span class=\"fg7 bg0\">Skills enhanced by cross-training are in </span><span class=\"fg2 bg0\">green</span><span class=\"fg7 bg0\">.",
  "",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">?</span><span class=\"fg7 bg0\">] Help                [</span><span class=\"fg14 bg0\">=</span><span class=\"fg7 bg0\">] set a skill target",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">/</span><span class=\"fg7 bg0\">] </span><span class=\"fg15 bg0\">auto</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">manual </span><span class=\"fg7 bg0\">mode    [</span><span class=\"fg14 bg0\">*</span><span class=\"fg7 bg0\">] </span><span class=\"fg15 bg0\">useful</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">all </span><span class=\"fg7 bg0\">skills    [</span><span class=\"fg14 bg0\">_</span><span class=\"fg7 bg0\">] </span><span class=\"fg15 bg0\">enhanced</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">base </span><span class=\"fg7 bg0\">level",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">!</span><span class=\"fg7 bg0\">] </span><span class=\"fg15 bg0\">training</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">cost</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">targets",
]

// A Gnoll, "cost" view: distributed training makes no skill selectable, so every
// row loses its hotkey letter and shows only the training sign. Both columns are
// full, and lines 9 and 13 carry a right-column cell whose left half is blank
// (the left column's group separator falls opposite them).
export const GNOLL_COST: string[] = [
  "      <span class=\"fg1 bg0\">Skill           Level Cost   Apt       Skill           Level Cost   Apt",
  "    <span class=\"fg7 bg0\">+ Fighting         6.4   </span><span class=\"fg3 bg0\">1.8   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Spellcasting     0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8",
  "",
  "    <span class=\"fg7 bg0\">+ Maces &amp; Flails   0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Conjurations     0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Axes             4.4   </span><span class=\"fg3 bg0\">1.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Hexes            0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Polearms         0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Summonings       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Staves           0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Necromancy       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Unarmed Combat   0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Forgecraft       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Throwing         0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Translocations   0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "                                           <span class=\"fg7 bg0\">+ Alchemy          0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Short Blades     0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Fire Magic       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Long Blades      0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Ice Magic        0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Ranged Weapons   0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Air Magic        0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "                                           <span class=\"fg7 bg0\">+ Earth Magic      0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Armour           6.4   </span><span class=\"fg3 bg0\">1.8   </span><span class=\"fg15 bg0\">+8",
  "    <span class=\"fg7 bg0\">+ Dodging          0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Invocations      0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+9",
  "    <span class=\"fg7 bg0\">+ Shields          6.4   </span><span class=\"fg3 bg0\">1.8   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Evocations       0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8",
  "    <span class=\"fg7 bg0\">+ Stealth          0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Shapeshifting    0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+7",
  "",
  " <span class=\"fg7 bg0\">The relative cost of raising each skill is in </span><span class=\"fg3 bg0\">cyan</span><span class=\"fg7 bg0\">.",
  " <span class=\"fg7 bg0\">The species aptitude is in </span><span class=\"fg15 bg0\">white</span><span class=\"fg7 bg0\">.",
  "",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">?</span><span class=\"fg7 bg0\">] Help",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">!</span><span class=\"fg7 bg0\">] </span><span class=\"fg8 bg0\">training</span><span class=\"fg7 bg0\">|</span><span class=\"fg15 bg0\">cost",
]

// The two shapes that have historically broken this code, on one Gnoll (forced
// with wizard mode):
//
//   line 1  mastered Fighting  — a mastered skill loses BOTH its hotkey and its
//           training sign, so on a Gnoll (no hotkeys to start with) the row
//           carries no anchor of any kind. It is the grid's first row.
//   line 9  mastered Alchemy   — mastered AND alone on its line, because its left
//           half is a group separator: the `Shapeshifting 27 -2` shape that used
//           to be misfiled below the grid as help text.
//   line 4  Axes with a manual — the tightest the grid ever gets. The manual
//           appends a lightred "+4" to the aptitude, filling that field to its
//           full 5 columns so the left cell reaches column 39, leaving a single
//           space before the right cell. The right column does not move; the
//           split at column 40 stays safe.
//
// Note the level column: a mastered level prints as a bare integer flush at
// column 22, while "%4.1f" levels right-align their digits at 23. That
// one-column stagger is the game's own — the reflow must not "fix" it.
export const GNOLL_MASTERED_MANUAL: string[] = [
  "      <span class=\"fg1 bg0\">Skill           Level Cost   Apt       Skill           Level Cost   Apt",
  "      <span class=\"fg14 bg0\">Fighting        27           </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Spellcasting     0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8",
  "",
  "    <span class=\"fg7 bg0\">+ Maces &amp; Flails   0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Conjurations     0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg9 bg0\">+ Axes             4.4   </span><span class=\"fg12 bg0\">0.6   </span><span class=\"fg15 bg0\">+8 </span><span class=\"fg12 bg0\">+4   </span><span class=\"fg7 bg0\">+ Hexes            0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Polearms         0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Summonings       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Staves           0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Necromancy       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Unarmed Combat   0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Forgecraft       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Throwing         0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Translocations   0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "                                             <span class=\"fg14 bg0\">Alchemy         27           </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Short Blades     0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Fire Magic       0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Long Blades      0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Ice Magic        0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Ranged Weapons   0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Air Magic        0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "                                           <span class=\"fg7 bg0\">+ Earth Magic      0.0   </span><span class=\"fg3 bg0\">0.3   </span><span class=\"fg15 bg0\">+6",
  "    <span class=\"fg7 bg0\">+ Armour           6.4   </span><span class=\"fg3 bg0\">1.8   </span><span class=\"fg15 bg0\">+8",
  "    <span class=\"fg7 bg0\">+ Dodging          0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Invocations      0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+9",
  "    <span class=\"fg7 bg0\">+ Shields          6.4   </span><span class=\"fg3 bg0\">1.8   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg7 bg0\">+ Evocations       0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8",
  "    <span class=\"fg7 bg0\">+ Stealth          0.0   </span><span class=\"fg3 bg0\">0.2   </span><span class=\"fg15 bg0\">+8      </span><span class=\"fg9 bg0\">+ Shapeshifting    0.0   </span><span class=\"fg12 bg0\">0.1   </span><span class=\"fg15 bg0\">+7 </span><span class=\"fg12 bg0\">+4",
  "",
  " <span class=\"fg7 bg0\">The species aptitude is in </span><span class=\"fg15 bg0\">white</span><span class=\"fg7 bg0\">. Bonus from skill manuals is in </span><span class=\"fg12 bg0\">red</span><span class=\"fg7 bg0\">.",
  "",
  "",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">?</span><span class=\"fg7 bg0\">] Help",
  " <span class=\"fg7 bg0\">[</span><span class=\"fg14 bg0\">!</span><span class=\"fg7 bg0\">] </span><span class=\"fg8 bg0\">training</span><span class=\"fg7 bg0\">|</span><span class=\"fg15 bg0\">cost</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">progress</span><span class=\"fg7 bg0\">|</span><span class=\"fg8 bg0\">points",
]
