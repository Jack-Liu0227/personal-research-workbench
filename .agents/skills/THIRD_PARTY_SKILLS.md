# Third-party project skills

These project-scoped skills are installed from fixed upstream revisions.

| Skill | Repository path | Revision | License |
| --- | --- | --- | --- |
| `grill-me` | `mattpocock/skills/skills/productivity/grill-me` | `5b15a47f2d7150f545fbcacbfe381787fc0230dc` | MIT |
| `grilling` | `mattpocock/skills/skills/productivity/grilling` | `5b15a47f2d7150f545fbcacbfe381787fc0230dc` | MIT |
| `ponytail` | `DietrichGebert/ponytail/skills/ponytail` | `2ed6c52c9d7e5e56942508591085fd45dea277d3` | MIT |
| `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill/.claude/skills/ui-ux-pro-max` | `bc826e2267a36d98a2dcf5231e16c30ff546770f` | MIT |

`ui-ux-pro-max/SKILL.md` has a project-local compatibility adjustment: its
Claude-specific script path was replaced with `.agents/skills/ui-ux-pro-max`.
`grill-me/SKILL.md` has a project-local compatibility adjustment: its
Claude-specific Skill-tool instruction was replaced with a `$grilling`
invocation supported by Codex.
The upstream license text is preserved in each installed skill directory.
