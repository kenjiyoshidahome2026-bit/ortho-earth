#pragma once

#include "CoreMinimal.h"

class AActor;
class AOrthoEarthAnchor;

namespace OrthoEarth
{
	/**
	 * Ortho Earth > Export selection to GLB…  (Unreal → ortho-earth, docs/notes/unreal-roundtrip.md §5)
	 *   Writes the selected actors with Unreal's glTF Exporter in the frame of their anchor, then stamps asset.extras.orthoEarth = { anchor, frame: "enu", heading }.
	 *   The exporter writes world space, so the anchor is moved to the origin (identity) for the export and put back afterwards:
	 *   actors attached under it follow, so the GLB holds anchor-local positions in glTF (east, up, south) metres — the file convention ortho-earth reads.
	 */
	bool ExportSelection(const TArray<AActor*>& Actors, AOrthoEarthAnchor* Anchor, const FString& Path, FString& OutLog);

	/** Insert "extras":{"orthoEarth":…} into the asset object of a GLB's JSON chunk and fix the chunk / total lengths. */
	bool StampExtras(TArray<uint8>& Glb, const FString& OrthoEarthJson, FString& OutError);
}
