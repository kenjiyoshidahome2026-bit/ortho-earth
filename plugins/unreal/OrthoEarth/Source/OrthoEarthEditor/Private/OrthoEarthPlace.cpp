#include "OrthoEarthPlace.h"
#include "OrthoEarthAnchor.h"
#include "OrthoEarthAttributeTable.h"
#include "OrthoEarthBuildingComponent.h"
#include "OrthoEarthLas.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetSelection.h"
#include "AssetToolsModule.h"
#include "AssetImportTask.h"
#include "Editor.h"
#include "EngineUtils.h"
#include "HAL/FileManager.h"
#include "InterchangeManager.h"
#include "InterchangeSourceData.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ScopedTransaction.h"
#include "UObject/Package.h"

#define LOCTEXT_NAMESPACE "OrthoEarth"

namespace OrthoEarth
{
	static FString Sanitize(const FString& S)
	{
		FString O = S;
		for (TCHAR& C : O) if (!FChar::IsAlnum(C) && C != TEXT('_')) C = TEXT('_');
		return O;
	}

	/** Import one GLB into the level (Interchange scene import) and return the actors it spawned. */
	static TArray<AActor*> ImportGlb(const FString& File, const FString& ContentPath, FString& Log)
	{
		TArray<AActor*> Actors;
		UInterchangeManager& Manager = UInterchangeManager::GetInterchangeManager();
		UInterchangeSourceData* Source = UInterchangeManager::CreateSourceData(File);
		FImportAssetParameters Params;
		Params.bIsAutomated = true;   // no import dialog: the glTF pipeline's defaults (m → cm, glTF (x, y, z) → Unreal (x, z, y))
		auto Results = Manager.ImportScene(ContentPath, Source, Params);
		UE::Interchange::FSceneImportResultRef Scene = Results.Get<1>();
		Scene->WaitUntilDone();
		for (UObject* O : Scene->GetImportedObjects()) if (AActor* A = Cast<AActor>(O)) Actors.Add(A);
		Log += FString::Printf(TEXT("  %s → %d actors (%s)\n"), *FPaths::GetCleanFilename(File), Actors.Num(), *ContentPath);
		return Actors;
	}

	/** The label Interchange gave a node actor, without a "_<n>" suffix added for duplicates. */
	static FString BaseLabel(const AActor* A)
	{
		FString L = A->GetActorLabel();
		int32 U;
		if (L.FindLastChar(TEXT('_'), U) && U + 1 < L.Len() && L.Mid(U + 1).IsNumeric()) return L.Left(U);
		return L;
	}

	static UOrthoEarthAttributeTable* MakeTable(const FString& JsonFile, const FString& ContentPath, FString& Log)
	{
		FString Text;
		if (!FFileHelper::LoadFileToString(Text, *JsonFile)) return nullptr;
		const FString Name = TEXT("buildings_attributes");
		UPackage* Pkg = CreatePackage(*(ContentPath / Name));
		UOrthoEarthAttributeTable* T = NewObject<UOrthoEarthAttributeTable>(Pkg, *Name, RF_Public | RF_Standalone | RF_Transactional);
		FString Err;
		if (!T->LoadJson(Text, Err)) { Log += TEXT("  ") + Err + TEXT("\n"); return nullptr; }
		FAssetRegistryModule::AssetCreated(T);
		Pkg->MarkPackageDirty();
		Log += FString::Printf(TEXT("  buildings.attributes.json → %s (%d buildings × %d keys)\n"), *T->GetPathName(), T->Buildings.Num(), T->Keys.Num());
		return T;
	}

	static int32 TagBuildings(const TArray<AActor*>& Actors, UOrthoEarthAttributeTable* Table)
	{
		int32 N = 0;
		for (AActor* A : Actors)
		{
			FString Id = A->GetActorLabel();
			if (Table->IndexOf(Id) == INDEX_NONE) Id = BaseLabel(A);
			if (Table->IndexOf(Id) == INDEX_NONE) continue;
			A->Modify();
			UOrthoEarthBuildingComponent* C = NewObject<UOrthoEarthBuildingComponent>(A, TEXT("OrthoEarthBuilding"), RF_Transactional);
			C->Id = Id; C->Table = Table; C->Attributes = Table->AttributesOf(Id);
			A->AddInstanceComponent(C);
			C->RegisterComponent();
			A->Tags.AddUnique(TEXT("PLATEAU"));
			A->Tags.AddUnique(FName(*Id));
			if (const FString* Usage = C->Attributes.Find(TEXT("bldg:usage"))) A->Tags.AddUnique(FName(*(TEXT("usage:") + *Usage)));
			N++;
		}
		return N;
	}

	/** Import a LAS through AssetTools (the LiDAR Point Cloud factory) and spawn its actor through the actor factory. */
	static AActor* ImportLas(UWorld* World, const FString& File, const FString& ContentPath, FString& Log)
	{
		UAssetImportTask* Task = NewObject<UAssetImportTask>();
		Task->Filename = File; Task->DestinationPath = ContentPath; Task->bAutomated = true; Task->bReplaceExisting = true; Task->bSave = false;
		FAssetToolsModule::GetModule().Get().ImportAssetTasks({ Task });
		const TArray<UObject*>& Objects = Task->GetObjects();
		if (Objects.Num() == 0) { Log += FString::Printf(TEXT("  %s: not imported (enable the LiDAR Point Cloud plugin)\n"), *FPaths::GetCleanFilename(File)); return nullptr; }
		UObject* Cloud = Objects[0];
		// The LiDAR importer may centre the cloud; put the points back at their file coordinates (metres from the LAS anchor).
		if (UFunction* Restore = Cloud->FindFunction(TEXT("RestoreOriginalCoordinates"))) Cloud->ProcessEvent(Restore, nullptr);
		AActor* A = FActorFactoryAssetProxy::AddActorForAsset(Cloud, false);
		if (A) A->SetActorLocation(FVector::ZeroVector);
		Log += FString::Printf(TEXT("  %s → %s\n"), *FPaths::GetCleanFilename(File), *Cloud->GetPathName());
		return A;
	}

	AOrthoEarthAnchor* PlaceExportFolder(UWorld* World, const FString& Folder, FString& Log)
	{
		FString Text, Err;
		const FString AnchorFile = Folder / TEXT("anchor.json");
		if (!World || !FFileHelper::LoadFileToString(Text, *AnchorFile)) { Log += FString::Printf(TEXT("No anchor.json in %s\n"), *Folder); return nullptr; }

		const FScopedTransaction Tx(LOCTEXT("Place", "Ortho Earth: place export folder"));
		const FString Name = FPaths::GetCleanFilename(FPaths::GetPath(Folder / TEXT("x")));
		const FString ContentPath = TEXT("/Game/OrthoEarth/") + Sanitize(Name);

		AOrthoEarthAnchor* Scene = nullptr;   // the level's anchor, if there is one already
		for (TActorIterator<AOrthoEarthAnchor> It(World); It; ++It) if (!It->GetAttachParentActor()) { Scene = *It; break; }

		AOrthoEarthAnchor* Anchor = World->SpawnActor<AOrthoEarthAnchor>(FVector::ZeroVector, FRotator::ZeroRotator);
		if (!Anchor->ApplyAnchorJson(Text, Err)) { Log += Err + TEXT("\n"); World->DestroyActor(Anchor); return nullptr; }
		Anchor->SetActorLabel(TEXT("Ortho Earth ") + Name);
		if (Scene)
		{
			// Translation only (as in the Unity package): the tilt between two anchors a few hundred metres apart is millimetres.
			Anchor->AttachToActor(Scene, FAttachmentTransformRules::KeepRelativeTransform);
			Anchor->SetActorRelativeLocation(OrthoEarth::LocalOf(Scene->Anchor, Anchor->Anchor.Lon, Anchor->Anchor.Lat, Anchor->Anchor.Height));
			Log += FString::Printf(TEXT("Attached to %s at %s cm\n"), *Scene->GetActorLabel(), *Anchor->GetRootComponent()->GetRelativeLocation().ToString());
		}
		Log += FString::Printf(TEXT("Anchor %.6f, %.6f, h %.2f m (geoid %.2f m)\n"), Anchor->Anchor.Lon, Anchor->Anchor.Lat, Anchor->Anchor.Height, Anchor->Geoid);

		TArray<FString> Files;
		IFileManager::Get().FindFiles(Files, *(Folder / TEXT("*.*")), true, false);
		Files.Sort();
		TArray<AActor*> Spawned;
		for (const FString& F : Files)
		{
			const FString Ext = FPaths::GetExtension(F).ToLower(), Path = Folder / F, Sub = ContentPath / Sanitize(FPaths::GetBaseFilename(F));
			if (Ext == TEXT("glb") || Ext == TEXT("gltf"))
			{
				const TArray<AActor*> Actors = ImportGlb(Path, Sub, Log);
				for (AActor* A : Actors)
				{
					if (!A->GetAttachParentActor()) A->AttachToActor(Anchor, FAttachmentTransformRules::KeepRelativeTransform);
					Spawned.Add(A);
				}
			}
			else if (Ext == TEXT("las"))
			{
				if (AActor* A = ImportLas(World, Path, Sub, Log))
				{
					A->AttachToActor(Anchor, FAttachmentTransformRules::KeepRelativeTransform);
					FLasAnchor La;
					if (ReadLasAnchor(Path, La))
						A->SetActorRelativeLocation(OrthoEarth::LocalOf(Anchor->Anchor, La.Lon, La.Lat, La.Height + (La.bOrthometric ? Anchor->Geoid : 0)));
					Spawned.Add(A);
				}
			}
		}

		const FString AttrFile = Folder / TEXT("buildings.attributes.json");
		if (FPaths::FileExists(AttrFile))
			if (UOrthoEarthAttributeTable* T = MakeTable(AttrFile, ContentPath, Log))
			{
				TArray<AActor*> Under;   // every actor under the anchor (node actors may come back from Interchange or only as children)
				Anchor->GetAttachedActors(Under, true, true);
				for (AActor* A : Spawned) Under.AddUnique(A);
				Log += FString::Printf(TEXT("  %d building actors got OrthoEarthBuilding + tags\n"), TagBuildings(Under, T));
			}

		GEditor->SelectNone(false, true);
		GEditor->SelectActor(Anchor, true, true);
		return Anchor;
	}
}

#undef LOCTEXT_NAMESPACE
