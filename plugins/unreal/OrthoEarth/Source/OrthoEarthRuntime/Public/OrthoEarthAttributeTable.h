// Building attributes of one ortho-export folder (buildings.attributes.json → this data asset). Same table as the Unity package:
//   keys[] shared by all buildings, one values[] row per building in the same order ("" = none), id = PLATEAU gml_id = the glTF node name.
#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "OrthoEarthAttributeTable.generated.h"

USTRUCT(BlueprintType)
struct ORTHOEARTHRUNTIME_API FOrthoEarthAttributeRow
{
	GENERATED_BODY()
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ortho Earth") FString Id;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ortho Earth") TArray<FString> Values;
};

UCLASS(BlueprintType)
class ORTHOEARTHRUNTIME_API UOrthoEarthAttributeTable : public UDataAsset
{
	GENERATED_BODY()
public:
	/** Attribute names shared by all rows (PLATEAU / CityGML keys, nested ones joined with '/') */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ortho Earth") TArray<FString> Keys;
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ortho Earth") TArray<FOrthoEarthAttributeRow> Buildings;
	/** Attribution of the data (keep it with any redistribution) */
	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "Ortho Earth") FString Source;

	/** Fill from buildings.attributes.json */
	bool LoadJson(const FString& JsonText, FString& OutError);

	/** Row index of a building id (gml_id), or INDEX_NONE */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth") int32 IndexOf(const FString& Id) const;
	/** Attribute value of a building ("" counts as missing) */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth") bool TryGet(const FString& Id, const FString& Key, FString& Value) const;
	/** The non-empty attributes of a building */
	UFUNCTION(BlueprintPure, Category = "Ortho Earth") TMap<FString, FString> AttributesOf(const FString& Id) const;

private:
	mutable TMap<FString, int32> ById, ByKey;
	void Index() const;
};
