// The anchor of a level or of one ortho-export folder: everything attached under this actor is in its local frame
// (cm, X east, Y south, Z up). "Ortho Earth > Place export folder…" spawns one from anchor.json; "Export selection to GLB…" writes it back
// into asset.extras.orthoEarth so ortho-earth puts the model at the same point of the Earth.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "OrthoEarthGeo.h"
#include "OrthoEarthAnchor.generated.h"

UCLASS(ClassGroup = "Ortho Earth", meta = (DisplayName = "Ortho Earth Anchor"))
class ORTHOEARTHRUNTIME_API AOrthoEarthAnchor : public AActor
{
	GENERATED_BODY()
public:
	AOrthoEarthAnchor();

	/** lon / lat / ellipsoidal height / heading of this actor's origin */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth", meta = (ShowOnlyInnerProperties))
	FOrthoEarthGeoAnchor Anchor;

	/** Geoid height at the anchor (metres), informational: ellipsoidal = orthometric + geoid */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth")
	double Geoid = 0;

	/** Bounding box of the export, degrees [west, south, east, north] (informational) */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth")
	TArray<double> BBox;

	/** Attribution of the data (keep it with any redistribution) */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth", meta = (MultiLine = true))
	FString Source;

	/** lon/lat/ellipsoidal height → world position */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth")
	FVector WorldOf(double Lon, double Lat, double Height) const;

	/** World position → lon/lat/ellipsoidal height */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth")
	void GeoOf(FVector World, double& Lon, double& Lat, double& Height) const;

	/** Read anchor.json (ortho-export) into this actor. Returns false (and leaves the actor as it was) on a bad file. */
	bool ApplyAnchorJson(const FString& JsonText, FString& OutError);
	/** asset.extras.orthoEarth for a GLB written from this anchor */
	FString ToExtrasJson(const FString& Generator) const;
};
