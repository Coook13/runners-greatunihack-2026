# Runners: website, video, live demo

Three minutes total, including the 1:58 video. The separate pitch-3min.md is a three-minute spoken pitch if the video is outside the judging timer. This running order assumes the video counts toward it.

## 0:00-0:25 — Website

Start on website chapter 01, The mission. Move to chapter 02, The problem, for the opening sentence; jump to chapter 05, The demo, when introducing the film. Avoid scrolling through every section.

“A network outage should not stop food reaching a child. Runners puts autonomous coordination inside the delivery fleet. Vehicles make local decisions, protect sensitive information and record custody without waiting for central dispatch. Our prototype tests this on real Ethiopian geography, with simulated deliveries. Here is what happens under pressure.”

## 0:25-2:23 — Video

Before presenting, use the website's local video picker in chapter 05 to load runners-2min.mp4. Play it full-screen at this point. It is silent and has no subtitles. Use pitch-2min.md for the voiceover, either recorded beforehand or spoken live. Its timecodes start at the beginning of the video. Do not add another speech over recorded narration.

## 2:23-3:00 — Live demo

Prepare a separate running demo tab before presenting. Leave it at the auditor view after the guided sequence. Do not restart the three-minute simulation during this segment.

“This is the running system. The auditor can open the sealed manifest, verify signed receipts and identify where weight changed. Each vehicle makes decisions from its own information, and carries messages across disconnected areas. We measure delivered intact, losses detected and data exposed. Nothing is foolproof; we make misuse detectable and attributable. Food delivery is the first application. The same architecture could support medicine distribution and disaster response. Runners keeps coordination inside the fleet.”

Point at the manifest and custody chain, then close the auditor panel to show the three KPIs. Avoid opening additional panels.

## Evidence and rehearsal notes

- The film uses simulated results, not field-deployment outcomes.
- “Losses detected” on the scorecard counts incidents attributed to a named holder. Central dispatch can report a short delivery without establishing which custody hop caused it.
- The device comparison is for the same last-mile device. Van access is broader.
- Keep both tabs and the video loaded before starting. The website and its Vercel deployment are managed separately by Claude. Selecting a local video previews it in that browser; it does not upload or publish the file.
