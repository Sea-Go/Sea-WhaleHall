# WhaleHall UI References

This document records how external products may inform WhaleHall without
copying their branding, assets, layouts, or proprietary expression. It works
with [FRONTEND_STANDARD.md](FRONTEND_STANDARD.md) and
[CALENDAR_STANDARD.md](CALENDAR_STANDARD.md).

## Reference policy

References are evidence for interaction and information-design decisions, not
templates. Borrow principles and proven patterns, then express them with
WhaleHall's own domain, Chinese copy, design tokens, spacing, and visual
identity.

Do not:

- copy logos, icons, illustrations, screenshots, source code, CSS, exact
  dimensions, color values, or distinctive branded compositions;
- reproduce another product screen pixel-for-pixel;
- use a brand name in product copy as a substitute for a requirement;
- download third-party artwork unless its license and repository inclusion are
  explicitly approved;
- let a reference override accessibility, privacy, domain correctness, or
  Electrobun window constraints.

## Product references

| Reference | WhaleHall may learn from | WhaleHall must not copy |
| --- | --- | --- |
| Linear | Compact desktop shell, restrained dark surfaces, hierarchy, fast keyboard-oriented navigation, low-noise dialogs | Logo, purple identity, exact sidebar, command palette, issue terminology, distinctive gradients or animation |
| Feishu Calendar | Calendar page structure, mini month placement, week-view density, time axis, current-time line, all-day area, toolbar hierarchy | Feishu branding, icons, exact colors, exact measurements, event styling, Chinese copy, or screenshot composition |
| Notion Calendar | Calendar visibility controls, event editing hierarchy, calendar/source organization, readable multi-calendar events | Notion branding, typography, monochrome identity, proprietary event editor, or exact sidebar |
| Morgen | AI-proposed schedule review, visible draft/approved distinction, adjustment before commitment | Brand colors, assistant voice, exact proposal cards, or automatic commitment behavior |
| Todoist | Natural-language-first goal entry, progressive disclosure, concise task language | Todoist red, icons, Quick Add layout, task model, or copy |
| Sunsama | Guided planning steps, workload/capacity confirmation, daily planning clarity | Exact wizard, illustrations, rituals, brand voice, or subscription prompts |
| RescueTime | Reports that first answer where time went, efficiency trends, and actionable summaries | Dashboard layout, scoring system, proprietary categories, exact chart colors, or invented productivity precision |
| ActivityWatch | Honest representation of local activity data, timelines, application/domain breakdown, visibility of missing data | Logo, data taxonomy, dashboard layout, or exposing raw sensitive values without consent |
| Raycast | Compact account hierarchy, settings categories, consistent setting rows, keyboard focus, restrained popovers | Raycast logo, icon set, red/purple identity, exact preference window, command UX, or shortcut defaults |

## WhaleHall visual identity

WhaleHall is a desktop personal planning and growth product with a deep-ocean
identity:

- dark ocean backgrounds and restrained cyan/teal accents;
- stable content surfaces with explicit borders and spacing;
- decoration concentrated in the sidebar, authentication surface, and empty
  states;
- dense work areas such as calendars and reports remain flat, aligned, and
  quiet;
- red is reserved for failures and severe conflicts;
- proposed content uses structure, pattern, border, icon, or text in addition
  to color;
- real Chinese product copy replaces placeholder and infrastructure wording;
- no emoji product icons, neon cyberpunk styling, generic AI gradients,
  decorative glass panels, or wave textures inside calendar grids.

Existing client colors may inform the first token draft, but all new UI must
consume named design tokens rather than copying raw values from the current
prototype CSS.

## Reference priority

When references conflict, apply this order:

1. WhaleHall product requirements, data correctness, privacy, and
   accessibility;
2. architecture and state rules in
   [FRONTEND_STANDARD.md](FRONTEND_STANDARD.md);
3. calendar domain and interaction rules in
   [CALENDAR_STANDARD.md](CALENDAR_STANDARD.md);
4. Feishu Calendar for calendar information hierarchy and density;
5. Linear for the overall shell and low-noise desktop interaction;
6. the task-specific reference: Todoist/Sunsama/Morgen for planning,
   RescueTime/ActivityWatch for reports, and Raycast for settings;
7. existing WhaleHall prototype styling where it remains compatible.

If two references still produce different valid designs, choose the option
that is clearer at `1180x720`, easier to operate by keyboard, and less likely
to hide data state.

## Visual evidence

User-provided reference screenshots are design input, not assets to ship.
Record which aspects were used in the pull request and include WhaleHall's own
before/after screenshots. Do not commit an external screenshot unless its
license and repository purpose are explicit.

Every UI pull request follows the visual workflow in
[AGENTS.md](../../AGENTS.md#visual-acceptance-workflow) and the screenshot
requirements in [CONTRIBUTING.md](../../CONTRIBUTING.md#pull-requests).
