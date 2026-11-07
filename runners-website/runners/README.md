# Runners

A local, single-page hackathon presentation about sealed-box relays that keep
moving when communications fail. The five chapters cover the mission, the
problem, the carrier mesh, protected information and receipt ledger, and a slot
for the three-minute demo video.

## Run locally

From this directory, run:

```powershell
.\start.cmd
```

Open **http://127.0.0.1:4173**. Keep the terminal open while using the page; press
Ctrl+C to stop it. Python 3 is the only preview-server requirement. No Node build,
API key, external font, map tile service or runtime CDN is required.

## Local dependencies

The browser libraries are stored in `vendor/`: Three.js, GSAP, ScrollTrigger and
MotionPathPlugin. Their versions, official npm package URLs and integrity digests
are recorded in `vendor/versions.json`. Three.js's license and GSAP's upstream
license declaration and README are stored beside the files.

The checked-in files work offline. To restore exactly the recorded dependencies
after deleting them, run the following with internet access:

```powershell
python scripts\fetch_vendors.py
```

Use `--refresh` only when deliberately upgrading. The downloader verifies npm
package integrity and reads named archive members instead of extracting arbitrary
paths.

## Experience

Scroll or use the chapter navigation to move between the five sections. The SVG
route provides the road geometry; GSAP ties its progress to scrolling, and the
Three.js scene presents the road and white delivery van in 3D. Camera framing
changes with the chapters. This landing page is an illustrative presentation of
the project, not the full routing simulation described in the build plan.

Use the final chapter's video picker to select the hackathon recording from this
computer. The recording is played locally through a browser object URL and is
not uploaded. A video file is not bundled yet. A saved recording can also be placed
under `media/` and referenced with a relative `src` on `#demo-video` in `index.html`;
the page then displays that recording automatically, with local file selection
available as a fallback.

The content is based on the supplied `PLAN.md`; it makes no claim of theft-proof
delivery or exactly-once delivery. Sensitive data and stock information are
described as access-limited, with carrier roles having different visibility.
