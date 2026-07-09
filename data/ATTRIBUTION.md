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

## Venus — `venus_heightfield.bin`

- **Source:** Magellan Venus Topography Global 4641m v02.
- **Mission:** NASA/JPL Magellan.
- **Provider:** USGS Astrogeology Science Center.
- **URL:** https://planetarymaps.usgs.gov/mosaic/Venus_Magellan_Topography_Global_4641m_v02.tif
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** int16 metres above the 6051000 m reference sphere; nodata pixels
  (polar coverage gaps, ~8% of cells) filled with valid-pixel mean; longitude
  convention was already −180..180 (no roll needed); resampled/formatted by
  `bake/bake_venus.py`.

## Mercury — `mercury_heightfield.bin`

- **Source:** Mercury MESSENGER USGS DEM Global 665m v2.
- **Mission:** NASA MESSENGER.
- **Provider:** USGS Astrogeology Science Center.
- **URL:** https://planetarymaps.usgs.gov/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** values decoded to metres above the 2439400 m reference sphere
  (see script for encoding details); longitude re-centered to −180..180 (roll by
  half-width from 0..360E source); downsampled ÷2 by exact block mean from native
  23040×11520 to 11520×5760; formatted by `bake/bake_mercury.py`.

## Sun — `sun_heightfield.bin`

- **Source:** NASA SDO/HMI Synoptic Radial Magnetogram, Carrington Rotation 2300
  (2025-07-19 – 2025-08-15).  Product: `hmi.Synoptic_Mr` (3600×1440 sin-latitude).
- **Mission:** NASA Solar Dynamics Observatory (SDO).
- **Instrument:** Helioseismic and Magnetic Imager (HMI).
- **Provider:** Joint Science Operations Center (JSOC), Stanford University.
- **URL:** https://jsoc1.stanford.edu/data/hmi/synoptic/
- **Courtesy:** HMI data courtesy of NASA/SDO and the HMI science team.
- **License:** Public domain (NASA / U.S. Government work; JSOC data are freely
  available for scientific and educational use).
- **Processing:** the radial magnetic field (Gauss, float32) is resampled from
  uniform sin-latitude × Carrington-longitude to equirectangular 2880×1440
  (uniform geographic lat/lon, col 0 = −180°, row 0 = +90N); NaN polar-cap
  gaps → 0 G; values encoded via signed sqrt compression
  `elev = round(sign(B) × sqrt(|B|/1500) × 30000)` so that quiet-sun |B|~5 G
  maps to |elev|~700 and active-region |B|~1000 G maps to |elev|~24500,
  yielding rich texture across the full dynamic range; formatted by
  `bake/bake_sun.py`.

To re-bake from the original sources, see `bake/README` notes in the bake
scripts (they download the upstream files into `bake/cache/`, which is
gitignored).
