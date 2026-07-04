# Data sources & attribution

The baked elevation blobs in this directory are derived from public-domain
government datasets. Both sources are in the **public domain**; this project
redistributes derived (resampled, reformatted) versions of them.

## Earth — `heightfield.bin` / `water_mask.bin`

- **Source:** ETOPO 2022 v1, 60 arc-second ice-surface global relief.
- **Provider:** NOAA National Centers for Environmental Information (NCEI).
- **URL:** https://www.ngdc.noaa.gov/mgg/global/ (ETOPO 2022)
- **License:** Public domain (U.S. Government work).
- **Processing:** resampled to the project grid and ocean/below-sea-level
  clamped to 0 by `bake/bake_earth.py`.

## Moon — `moon_heightfield.bin`

- **Source:** Lunar Orbiter Laser Altimeter (LOLA) global DEM (LDEM).
- **Mission:** NASA Lunar Reconnaissance Orbiter (LRO).
- **Provider:** NASA PDS Geosciences Node (Washington University in St. Louis).
- **URL:** https://pds-geosciences.wustl.edu/missions/lro/lola.htm
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** elevation taken relative to the 1737.4 km reference sphere,
  longitude re-centered to −180..180, resampled by `bake/bake_moon.py`.

## Mars — `mars_heightfield.bin`

- **Source:** MOLA MEGDR global topography (megt), 32 pixels/degree.
- **Mission:** NASA Mars Global Surveyor (MGS), Mars Orbiter Laser Altimeter.
- **Provider:** NASA PDS Geosciences Node (Washington University in St. Louis).
- **URL:** https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** big-endian int16 metres above the areoid (no ocean clamp),
  longitude re-centered to −180..180, resampled by `bake/bake_mars.py`.

To re-bake from the original sources, see `bake/README` notes in the bake
scripts (they download the upstream files into `bake/cache/`, which is
gitignored).
