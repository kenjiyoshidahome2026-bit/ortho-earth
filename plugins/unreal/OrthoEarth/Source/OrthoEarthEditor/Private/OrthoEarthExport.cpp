#include "OrthoEarthExport.h"
#include "OrthoEarthAnchor.h"

#include "Exporters/GLTFExporter.h"
#include "Options/GLTFExportOptions.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

namespace OrthoEarth
{
	static const TCHAR* Generator = TEXT("ortho-earth unreal 0.1");

	static uint32 ReadU32(const TArray<uint8>& B, int32 O) { return uint32(B[O]) | uint32(B[O + 1]) << 8 | uint32(B[O + 2]) << 16 | uint32(B[O + 3]) << 24; }
	static void WriteU32(TArray<uint8>& B, int32 O, uint32 V) { B[O] = V & 255; B[O + 1] = (V >> 8) & 255; B[O + 2] = (V >> 16) & 255; B[O + 3] = (V >> 24) & 255; }

	bool StampExtras(TArray<uint8>& Glb, const FString& OrthoEarthJson, FString& Err)
	{
		if (Glb.Num() < 20 || ReadU32(Glb, 0) != 0x46546C67) { Err = TEXT("not a GLB"); return false; }
		const int32 JsonLen = int32(ReadU32(Glb, 12));
		if (ReadU32(Glb, 16) != 0x4E4F534A || 20 + JsonLen > Glb.Num()) { Err = TEXT("first chunk is not JSON"); return false; }
		FUTF8ToTCHAR Conv(reinterpret_cast<const ANSICHAR*>(Glb.GetData() + 20), JsonLen);
		FString Json(Conv.Length(), Conv.Get());
		Json.TrimEndInline();
		const FString Key = TEXT("\"asset\":{");
		const int32 A = Json.Find(Key, ESearchCase::CaseSensitive);
		if (A == INDEX_NONE) { Err = TEXT("GLB without asset"); return false; }
		const int32 Ins = A + Key.Len();
		const FString Ours = TEXT("\"extras\":{\"orthoEarth\":") + OrthoEarthJson + TEXT("}");
		FString Patched = Json.Left(Ins) + Ours + TEXT(",") + Json.Mid(Ins);
		// an existing asset.extras right after ours: merge the two objects
		Patched.ReplaceInline(*(Ours + TEXT(",\"extras\":{")), *(Ours.LeftChop(1) + TEXT(",")), ESearchCase::CaseSensitive);
		FTCHARToUTF8 Out(*Patched);
		const int32 NewLen = Out.Length(), Pad = (4 - NewLen % 4) % 4;
		TArray<uint8> Result;
		Result.Append(Glb.GetData(), 12);
		Result.AddUninitialized(8);
		Result.Append(reinterpret_cast<const uint8*>(Out.Get()), NewLen);
		for (int32 i = 0; i < Pad; i++) Result.Add(0x20);
		Result.Append(Glb.GetData() + 20 + JsonLen, Glb.Num() - 20 - JsonLen);
		WriteU32(Result, 12, uint32(NewLen + Pad));
		WriteU32(Result, 16, 0x4E4F534A);
		WriteU32(Result, 8, uint32(Result.Num()));
		Glb = MoveTemp(Result);
		return true;
	}

	bool ExportSelection(const TArray<AActor*>& Actors, AOrthoEarthAnchor* Anchor, const FString& Path, FString& Log)
	{
		if (!Anchor || Actors.Num() == 0) { Log += TEXT("Nothing to export\n"); return false; }
		TSet<AActor*> Selected;
		for (AActor* A : Actors)
		{
			if (A == Anchor) continue;
			if (!A->IsAttachedTo(Anchor)) Log += FString::Printf(TEXT("  warning: %s is not under %s (exported in world space)\n"), *A->GetActorLabel(), *Anchor->GetActorLabel());
			Selected.Add(A);
			TArray<AActor*> Children; A->GetAttachedActors(Children, true, true);
			Selected.Append(Children);
		}

		UGLTFExportOptions* Options = NewObject<UGLTFExportOptions>();
		Options->ResetToDefault();
		// Interchange builds Nanite meshes, whose render data is the coarse fallback: export the source model (the imported vertices) instead.
		// Looked up by name so that an engine without the option still compiles.
		if (FBoolProperty* SourceModel = FindFProperty<FBoolProperty>(UGLTFExportOptions::StaticClass(), TEXT("bExportSourceModel"))) SourceModel->SetPropertyValue_InContainer(Options, true);
		FGLTFExportMessages Messages;
		const FString Tmp = FPaths::ChangeExtension(Path, TEXT("tmp.glb"));

		const FTransform Saved = Anchor->GetActorTransform();
		Anchor->SetActorTransform(FTransform::Identity);
		const bool bOk = UGLTFExporter::ExportToGLTF(Anchor->GetWorld(), Tmp, Options, Selected, Messages);
		Anchor->SetActorTransform(Saved);

		for (const FString& M : Messages.Errors) Log += TEXT("  glTF error: ") + M + TEXT("\n");
		for (const FString& M : Messages.Warnings) Log += TEXT("  glTF warning: ") + M + TEXT("\n");
		TArray<uint8> Glb;
		if (!bOk || !FFileHelper::LoadFileToArray(Glb, *Tmp)) { Log += TEXT("glTF Exporter failed\n"); IFileManager::Get().Delete(*Tmp); return false; }
		IFileManager::Get().Delete(*Tmp);
		FString Err;
		if (!StampExtras(Glb, Anchor->ToExtrasJson(Generator), Err) || !FFileHelper::SaveArrayToFile(Glb, *Path)) { Log += Err + TEXT("\n"); return false; }
		Log += FString::Printf(TEXT("Wrote %s (%d actors) with anchor %.6f, %.6f, h %.2f m, heading %.1f°. Drop it on www.ortho-earth.com/japan/ or convert with glbconv.\n"),
			*Path, Selected.Num(), Anchor->Anchor.Lon, Anchor->Anchor.Lat, Anchor->Anchor.Height, Anchor->Anchor.Heading);
		return true;
	}
}
