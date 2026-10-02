"""Create a small, explicitly synthetic GeoTIFF to verify local raster overlay."""
from pathlib import Path
import argparse

from osgeo import gdal, osr
import numpy as np

gdal.UseExceptions()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="artifacts/fixtures/test-basemap.tif")
    args = parser.parse_args()
    path = Path(args.output).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = 900, 800
    xmin, ymax, span_x, span_y = 447900.0, 4420900.0, 1400.0, 1200.0
    yy, xx = np.mgrid[0:height, 0:width]
    blocks = ((xx // 90 + yy // 100) % 2).astype(np.uint8)
    colors = np.stack([54 + blocks * 7, 70 + blocks * 8, 63 + blocks * 6])
    roads = (xx % 150 < 9) | (yy % 170 < 9)
    colors[:, roads] = np.array([92, 105, 112])[:, None]
    dataset = gdal.GetDriverByName("GTiff").Create(
        str(path), width, height, 3, gdal.GDT_Byte,
        options=["TILED=YES", "COMPRESS=DEFLATE"])
    dataset.SetGeoTransform((xmin, span_x / width, 0, ymax, 0, -span_y / height))
    crs = osr.SpatialReference()
    crs.ImportFromEPSG(32650)
    dataset.SetProjection(crs.ExportToWkt())
    dataset.SetMetadataItem("DESCRIPTION", "SYNTHETIC TEST GRID - NOT SATELLITE IMAGERY")
    for index, channel in enumerate(colors, 1):
        dataset.GetRasterBand(index).WriteArray(channel)
    dataset.BuildOverviews("AVERAGE", [2, 4, 8])
    dataset = None
    print(path)


if __name__ == "__main__":
    main()
