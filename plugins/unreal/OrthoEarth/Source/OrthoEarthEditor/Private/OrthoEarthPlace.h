#pragma once

#include "CoreMinimal.h"

class AOrthoEarthAnchor;
class UWorld;

namespace OrthoEarth
{
	/**
	 * Ortho Earth > Place export folder…  (ortho-export output → this level, docs/notes/unreal-roundtrip.md §3)
	 *   anchor.json  → an AOrthoEarthAnchor (at the origin, or attached to the level's first anchor and offset by the difference of the two anchors)
	 *   *.glb        → Interchange "import into level" under /Game/OrthoEarth/<folder>/<file>; the root actors are attached to the anchor
	 *   buildings.attributes.json → UOrthoEarthAttributeTable asset + UOrthoEarthBuildingComponent and tags on every building actor
	 *   *.las        → LiDAR Point Cloud asset + actor, offset by its anchor VLR (needs the LiDAR Point Cloud plugin)
	 */
	AOrthoEarthAnchor* PlaceExportFolder(UWorld* World, const FString& Folder, FString& OutLog);
}
