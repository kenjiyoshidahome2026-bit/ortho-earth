// Geodesy for the ortho-earth anchor (docs/notes/unreal-roundtrip.md §2). Double precision: ECEF magnitudes are ~6.4e6 m.
//   ENU at the anchor = east, north, up (metres).
//   Unreal local frame under an OrthoEarthAnchor = X east, Y south, Z up, centimetres (left-handed; the Cesium for Unreal frame).
//   glTF (the file) = X east, Y up, Z south. Unreal's glTF importer (Interchange) maps glTF (x, y, z) → Unreal (x, z, y) × 100,
//   which is exactly this frame: GLBs from ortho-export need no extra rotation node (unlike Unity/glTFast).
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "OrthoEarthGeo.generated.h"

/** The point of the Earth that is the origin of a level (or of one export folder). */
USTRUCT(BlueprintType)
struct ORTHOEARTHRUNTIME_API FOrthoEarthGeoAnchor
{
	GENERATED_BODY()

	/** Longitude, degrees (WGS84 / JGD2011) */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth") double Lon = 0;
	/** Latitude, degrees */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth") double Lat = 0;
	/** Ellipsoidal height, metres (orthometric + geoid) */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth") double Height = 0;
	/** Degrees clockwise from north: where the model's north (−Y) points. 0 = model −Y is north */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Ortho Earth") double Heading = 0;

	FOrthoEarthGeoAnchor() = default;
	FOrthoEarthGeoAnchor(double InLon, double InLat, double InHeight, double InHeading = 0) : Lon(InLon), Lat(InLat), Height(InHeight), Heading(InHeading) {}
};

namespace OrthoEarth
{
	constexpr double WGS84_A = 6378137.0, WGS84_F = 1.0 / 298.257223563, WGS84_E2 = WGS84_F * (2 - WGS84_F);

	ORTHOEARTHRUNTIME_API void LonLatToEcef(double Lon, double Lat, double H, double& X, double& Y, double& Z);
	ORTHOEARTHRUNTIME_API void EcefToLonLat(double X, double Y, double Z, double& Lon, double& Lat, double& H);
	/** East, north, up (metres) of lon/lat/h seen from the anchor (heading ignored). */
	ORTHOEARTHRUNTIME_API FVector EnuOf(const FOrthoEarthGeoAnchor& A, double Lon, double Lat, double H);
	/** lon/lat/h → Unreal local position under the anchor (cm, X east, Y south, Z up), heading applied. */
	ORTHOEARTHRUNTIME_API FVector LocalOf(const FOrthoEarthGeoAnchor& A, double Lon, double Lat, double H);
	/** Unreal local position under the anchor → lon/lat/h. */
	ORTHOEARTHRUNTIME_API void GeoOf(const FOrthoEarthGeoAnchor& A, const FVector& Local, double& Lon, double& Lat, double& H);
}

UCLASS()
class ORTHOEARTHRUNTIME_API UOrthoEarthGeoLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	/** lon/lat/ellipsoidal height → local position under the anchor (cm, X east, Y south, Z up) */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth")
	static FVector LocalOfGeo(const FOrthoEarthGeoAnchor& Anchor, double Lon, double Lat, double Height) { return OrthoEarth::LocalOf(Anchor, Lon, Lat, Height); }

	/** Local position under the anchor → lon/lat/ellipsoidal height */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth")
	static void GeoOfLocal(const FOrthoEarthGeoAnchor& Anchor, FVector Local, double& Lon, double& Lat, double& Height) { OrthoEarth::GeoOf(Anchor, Local, Lon, Lat, Height); }
};
