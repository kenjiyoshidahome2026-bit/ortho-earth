#include "OrthoEarthAnchor.h"
#include "Components/SceneComponent.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Policies/CondensedJsonPrintPolicy.h"

AOrthoEarthAnchor::AOrthoEarthAnchor()
{
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	PrimaryActorTick.bCanEverTick = false;
}

FVector AOrthoEarthAnchor::WorldOf(double Lon, double Lat, double Height) const
{
	return GetActorTransform().TransformPosition(OrthoEarth::LocalOf(Anchor, Lon, Lat, Height));
}

void AOrthoEarthAnchor::GeoOf(FVector World, double& Lon, double& Lat, double& Height) const
{
	OrthoEarth::GeoOf(Anchor, GetActorTransform().InverseTransformPosition(World), Lon, Lat, Height);
}

bool AOrthoEarthAnchor::ApplyAnchorJson(const FString& JsonText, FString& OutError)
{
	TSharedPtr<FJsonObject> J;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JsonText), J) || !J.IsValid()) { OutError = TEXT("anchor.json is not JSON"); return false; }
	const TSharedPtr<FJsonObject>* A = nullptr;
	if (!J->TryGetObjectField(TEXT("anchor"), A) || !A) { OutError = TEXT("anchor.json has no \"anchor\""); return false; }
	double Lon, Lat, H;
	if (!(*A)->TryGetNumberField(TEXT("lon"), Lon) || !(*A)->TryGetNumberField(TEXT("lat"), Lat) || !(*A)->TryGetNumberField(TEXT("height"), H)) { OutError = TEXT("anchor needs lon, lat, height"); return false; }
	FString Frame;
	if (J->TryGetStringField(TEXT("frame"), Frame) && Frame != TEXT("enu")) { OutError = FString::Printf(TEXT("unknown frame \"%s\" (expected enu)"), *Frame); return false; }
	Modify();
	Anchor.Lon = Lon; Anchor.Lat = Lat; Anchor.Height = H;
	double V = 0;
	Anchor.Heading = J->TryGetNumberField(TEXT("heading"), V) ? V : 0;
	Geoid = J->TryGetNumberField(TEXT("geoid"), V) ? V : 0;
	BBox.Reset();
	const TArray<TSharedPtr<FJsonValue>>* B = nullptr;
	if (J->TryGetArrayField(TEXT("bbox"), B)) for (const TSharedPtr<FJsonValue>& X : *B) BBox.Add(X->AsNumber());
	TArray<FString> Lines;
	const TArray<TSharedPtr<FJsonValue>>* S = nullptr;
	if (J->TryGetArrayField(TEXT("source"), S))
		for (const TSharedPtr<FJsonValue>& X : *S)
		{
			const TSharedPtr<FJsonObject> O = X->AsObject(); if (!O) continue;
			FString Name, Lic, Attr;
			O->TryGetStringField(TEXT("name"), Name); O->TryGetStringField(TEXT("license"), Lic); O->TryGetStringField(TEXT("attribution"), Attr);
			const FString Line = FString::Printf(TEXT("%s (%s, %s)"), *Name, *Attr, *Lic);
			if (!Lines.Contains(Line)) Lines.Add(Line);
		}
	Source = FString::Join(Lines, TEXT("\n"));
	return true;
}

FString AOrthoEarthAnchor::ToExtrasJson(const FString& Generator) const
{
	TSharedRef<FJsonObject> J = MakeShared<FJsonObject>(), A = MakeShared<FJsonObject>();
	A->SetNumberField(TEXT("lon"), Anchor.Lon); A->SetNumberField(TEXT("lat"), Anchor.Lat); A->SetNumberField(TEXT("height"), Anchor.Height);
	J->SetNumberField(TEXT("version"), 1);
	J->SetObjectField(TEXT("anchor"), A);
	J->SetStringField(TEXT("frame"), TEXT("enu"));
	J->SetNumberField(TEXT("heading"), Anchor.Heading);
	J->SetNumberField(TEXT("geoid"), Geoid);
	if (BBox.Num() == 4) { TArray<TSharedPtr<FJsonValue>> B; for (double X : BBox) B.Add(MakeShared<FJsonValueNumber>(X)); J->SetArrayField(TEXT("bbox"), B); }
	J->SetStringField(TEXT("generator"), Generator);
	FString Out;
	FJsonSerializer::Serialize(J, TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out));
	return Out;
}
