// The ortho-earth anchor VLR of a LAS file (/japan/pointcloud "LAS (points, for Unreal)", apps/pointcloud/pc-las.ts):
//   user "orthoEarth", record 1, JSON { anchor: { lon, lat, height, datum: "orthometric" }, frame: "enu", units: "m" }.
#pragma once

#include "CoreMinimal.h"

namespace OrthoEarth
{
	struct FLasAnchor { double Lon = 0, Lat = 0, Height = 0; bool bOrthometric = true; };
	/** Read the anchor VLR from a LAS file (header + VLRs only). False when the file has none. */
	bool ReadLasAnchor(const FString& Path, FLasAnchor& Out);
}
