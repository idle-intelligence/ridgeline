# Data sources & attribution

The baked elevation blobs in this directory are derived from published
government and agency datasets. Each source is listed below with its own terms:
the US-government products (NASA, NOAA, USGS) are public domain, and the
DLR-produced Dawn DTMs for Ceres and Vesta are freely available for reuse with
credit. This project redistributes derived (resampled, reformatted) versions of
all of them.

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

## Ceres — `ceres_heightfield.bin`

- **Source:** Ceres Dawn FC HAMO DTM DLR Global 60ppd Oct2016.
- **Mission:** NASA Dawn.
- **Instrument:** Framing Camera (FC), High Altitude Mapping Orbit (HAMO).
- **Provider:** DLR (German Aerospace Center) / USGS Astrogeology Science Center.
- **URL:** https://planetarymaps.usgs.gov/mosaic/Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif
- **License:** Dawn mission data are NASA / U.S. Government work (public domain); this DTM
  was produced by DLR and is freely available for reuse with credit to DLR and the Dawn team.
- **Processing:** uint16 radius-encoded values decoded to metres above the 470000 m
  reference sphere (DN values = local radius in metres; subtract 470000); longitude
  re-centered to −180..180 (roll by half-width if source is 0..360E); resampled from
  native 21600×10800 to 11520×5760 by bilinear interpolation (factor 1.875);
  formatted by `bake/bake_ceres.py`.

## Vesta — `vesta_heightfield.bin`

- **Source:** Vesta Dawn HAMO DTM DLR Global 48ppd.
- **Mission:** NASA Dawn.
- **Instrument:** Framing Camera (FC), High Altitude Mapping Orbit (HAMO).
- **Provider:** DLR (German Aerospace Center) / USGS Astrogeology Science Center.
- **URL:** https://planetarymaps.usgs.gov/mosaic/Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif
- **License:** Dawn mission data are NASA / U.S. Government work (public domain); this DTM
  was produced by DLR and is freely available for reuse with credit to DLR and the Dawn team.
- **Processing:** float32 values are local radii in metres; subtract 255000 m reference
  to obtain topographic heights; longitude origin determined from GeoTIFF tiepoint
  (see `lon_convention_note` in `vesta_meta.json` — a ~150° eastward shift relative to
  the IAU Claudia system is a known quirk of this USGS delivery); resampled from native
  17280×8640 to 11520×5760 by bilinear interpolation (factor 1.5); formatted by
  `bake/bake_vesta.py`. Note: Vesta is highly non-spherical (triaxial axes ~286×278×223 km);
  the sphere-mapped render appears lumpy — this reflects real topography.

## Enceladus — `enceladus_heightfield.bin`

- **Source:** Enceladus Cassini DEM Global 200m, Schenk & McKinnon 2024.
- **Mission:** NASA/ESA Cassini-Huygens.
- **Instrument:** Imaging Science Subsystem (ISS) stereo photogrammetry.
- **Authors:** Paul Schenk & William McKinnon (2024).
- **Provider:** USGS Astrogeology Science Center (ASC Astropedia).
- **URL:** https://asc-astropedia.s3.us-west-2.amazonaws.com/Enceladus/Cassini/Enceladus_Cassini_DEM_global_200m_schenk2024.tif
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** float32 source values in kilometres converted to metres (×1000);
  longitude convention inspected from GeoTIFF tiepoints (roll applied if 0..360E);
  resampled from native 8049×4025 to 7680×3840 by numpy bilinear interpolation;
  formatted by `bake/bake_enceladus.py`. South-polar tiger-stripe terrain is
  anomalously low/rugged vs northern plains (global range ≈ ±2.7 km).

## Pluto — `pluto_heightfield.bin`

- **Source:** Pluto New Horizons Global DEM 300m, July 2017 (16-bit).
- **Mission:** NASA New Horizons.
- **Instruments:** LORRI (Long Range Reconnaissance Imager) and MVIC (Multispectral
  Visible Imaging Camera).
- **Provider:** USGS Astrogeology Science Center.
- **URL:** https://planetarymaps.usgs.gov/mosaic/Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** int16 metres above the 1188300 m reference sphere; longitude
  convention inspected from GeoTIFF tiepoints (roll applied if 0..360E); resampled
  from native 24888×12444 to 11520×5760 by numpy bilinear interpolation; formatted
  by `bake/bake_pluto.py`. **COVERAGE NOTE:** New Horizons imaged only the encounter
  hemisphere (~0–180E) during the July 2015 flyby; the far side (~180–360E) is
  synthetic smooth fill. Estimated ~50% real coverage (see `coverage_note` in
  `pluto_meta.json` for exact fraction). Sputnik Planitia (~20N 180E) is a deep
  basin ≈ −3.5 km; global range ≈ −4..+6 km.

## Charon — `charon_heightfield.bin`

- **Source:** Charon New Horizons Global DEM 300m, July 2017 (16-bit).
- **Mission:** NASA New Horizons.
- **Instruments:** LORRI (Long Range Reconnaissance Imager) and MVIC (Multispectral
  Visible Imaging Camera).
- **Provider:** USGS Astrogeology Science Center.
- **URL:** https://planetarymaps.usgs.gov/mosaic/Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif
- **License:** Public domain (NASA / U.S. Government work).
- **Processing:** int16 metres above the 606000 m reference sphere; longitude
  convention inspected from GeoTIFF tiepoints (roll applied if 0..360E); resampled
  from native 12693×6347 to 5760×2880 by numpy bilinear interpolation; formatted by
  `bake/bake_charon.py`. **COVERAGE NOTE:** Same one-hemisphere coverage caveat as
  Pluto — encounter hemisphere only; far side is synthetic fill (~50%). Serenity
  Chasma (equatorial canyon belt) and Kubrick Mons ("mountain in a moat") are
  prominent features in the imaged hemisphere; global range ≈ −6..+5 km.

To re-bake from the original sources, run the per-body script in `bake/` (see the
re-baking section of the repo README). Each script downloads its upstream file
into `bake/cache/`, which is gitignored.
