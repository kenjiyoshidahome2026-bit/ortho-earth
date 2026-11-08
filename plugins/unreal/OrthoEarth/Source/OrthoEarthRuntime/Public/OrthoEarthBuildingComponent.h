// One PLATEAU building: Place adds this to every imported actor whose label is a gml_id of buildings.attributes.json.
//   Attributes are copied here (non-empty ones) so the Details panel shows them; the actor also gets the tags
//   "PLATEAU", the gml_id and "usage:<bldg:usage>" for quick filtering (Outliner search, GetAllActorsWithTag).
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "OrthoEarthBuildingComponent.generated.h"

class UOrthoEarthAttributeTable;

UCLASS(ClassGroup = "Ortho Earth", meta = (BlueprintSpawnableComponent, DisplayName = "Ortho Earth Building"))
class ORTHOEARTHRUNTIME_API UOrthoEarthBuildingComponent : public UActorComponent
{
	GENERATED_BODY()
public:
	/** PLATEAU gml_id */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Ortho Earth") FString Id;
	/** CityGML attributes of this building (bldg:usage, bldg:measuredHeight, …) */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Ortho Earth") TMap<FString, FString> Attributes;
	/** The whole table of the export folder */
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Ortho Earth") TObjectPtr<UOrthoEarthAttributeTable> Table;

	/** Attribute value ("" when missing) */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth") FString Get(const FString& Key) const { const FString* V = Attributes.Find(Key); return V ? *V : FString(); }
	/** bldg:measuredHeight in metres, or −1 */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth") double MeasuredHeight() const;
};
