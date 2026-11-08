#include "OrthoEarthAttributeTable.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

bool UOrthoEarthAttributeTable::LoadJson(const FString& JsonText, FString& OutError)
{
	TSharedPtr<FJsonObject> J;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JsonText), J) || !J.IsValid()) { OutError = TEXT("attributes: not JSON"); return false; }
	const TArray<TSharedPtr<FJsonValue>>* K = nullptr; const TArray<TSharedPtr<FJsonValue>>* B = nullptr;
	if (!J->TryGetArrayField(TEXT("keys"), K) || !J->TryGetArrayField(TEXT("buildings"), B)) { OutError = TEXT("attributes: needs keys and buildings"); return false; }
	Keys.Reset(); Buildings.Reset();
	for (const TSharedPtr<FJsonValue>& X : *K) Keys.Add(X->AsString());
	for (const TSharedPtr<FJsonValue>& X : *B)
	{
		const TSharedPtr<FJsonObject> O = X->AsObject(); if (!O) continue;
		FOrthoEarthAttributeRow Row; O->TryGetStringField(TEXT("id"), Row.Id);
		const TArray<TSharedPtr<FJsonValue>>* V = nullptr;
		if (O->TryGetArrayField(TEXT("values"), V)) for (const TSharedPtr<FJsonValue>& Y : *V) Row.Values.Add(Y->AsString());
		Buildings.Add(MoveTemp(Row));
	}
	J->TryGetStringField(TEXT("source"), Source);
	ById.Reset(); ByKey.Reset();
	return true;
}

void UOrthoEarthAttributeTable::Index() const
{
	if (ById.Num() != Buildings.Num()) { ById.Reset(); for (int32 i = 0; i < Buildings.Num(); i++) ById.Add(Buildings[i].Id, i); }
	if (ByKey.Num() != Keys.Num()) { ByKey.Reset(); for (int32 i = 0; i < Keys.Num(); i++) ByKey.Add(Keys[i], i); }
}

int32 UOrthoEarthAttributeTable::IndexOf(const FString& Id) const
{
	Index();
	const int32* R = ById.Find(Id);
	return R ? *R : INDEX_NONE;
}

bool UOrthoEarthAttributeTable::TryGet(const FString& Id, const FString& Key, FString& Value) const
{
	Index();
	const int32* R = ById.Find(Id); const int32* C = ByKey.Find(Key);
	if (!R || !C || !Buildings[*R].Values.IsValidIndex(*C) || Buildings[*R].Values[*C].IsEmpty()) return false;
	Value = Buildings[*R].Values[*C];
	return true;
}

TMap<FString, FString> UOrthoEarthAttributeTable::AttributesOf(const FString& Id) const
{
	TMap<FString, FString> Out;
	const int32 R = IndexOf(Id);
	if (R == INDEX_NONE) return Out;
	const TArray<FString>& V = Buildings[R].Values;
	for (int32 i = 0; i < Keys.Num() && i < V.Num(); i++) if (!V[i].IsEmpty()) Out.Add(Keys[i], V[i]);
	return Out;
}
