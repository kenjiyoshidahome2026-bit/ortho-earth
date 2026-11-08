// Menus: Tools > Ortho Earth > Place export folder… / Export selection to GLB…
#include "OrthoEarthAnchor.h"
#include "OrthoEarthExport.h"
#include "OrthoEarthPlace.h"

#include "DesktopPlatformModule.h"
#include "Editor.h"
#include "Engine/Selection.h"
#include "EngineUtils.h"
#include "Framework/Application/SlateApplication.h"
#include "IDesktopPlatform.h"
#include "Misc/MessageDialog.h"
#include "Modules/ModuleManager.h"
#include "ToolMenus.h"

#define LOCTEXT_NAMESPACE "OrthoEarth"

DEFINE_LOG_CATEGORY_STATIC(LogOrthoEarth, Log, All);

class FOrthoEarthEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FOrthoEarthEditorModule::RegisterMenus));
	}
	virtual void ShutdownModule() override
	{
		UToolMenus::UnRegisterStartupCallback(this);
		UToolMenus::UnregisterOwner(this);
	}

private:
	static void Report(const FString& Log, bool bOk)
	{
		UE_LOG(LogOrthoEarth, Display, TEXT("%s"), *Log);
		if (!bOk) FMessageDialog::Open(EAppMsgType::Ok, FText::FromString(Log), LOCTEXT("Title", "Ortho Earth"));
	}

	static void Place()
	{
		IDesktopPlatform* DP = FDesktopPlatformModule::Get();
		FString Folder;
		if (!DP || !DP->OpenDirectoryDialog(FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr), TEXT("ortho-export folder (anchor.json, *.glb, *.las)"), FPaths::ProjectDir(), Folder)) return;
		FString Log;
		const bool bOk = OrthoEarth::PlaceExportFolder(GEditor->GetEditorWorldContext().World(), Folder, Log) != nullptr;
		Report(Log, bOk);
	}

	static void Export()
	{
		TArray<AActor*> Actors;
		GEditor->GetSelectedActors()->GetSelectedObjects<AActor>(Actors);
		if (Actors.Num() == 0) { Report(TEXT("Select the actors to export first."), false); return; }
		AOrthoEarthAnchor* Anchor = nullptr;
		for (AActor* A : Actors)
		{
			for (AActor* P = A; P && !Anchor; P = P->GetAttachParentActor()) Anchor = Cast<AOrthoEarthAnchor>(P);
			if (Anchor) break;
		}
		if (!Anchor) { TActorIterator<AOrthoEarthAnchor> It(GEditor->GetEditorWorldContext().World()); if (It) Anchor = *It; }
		if (!Anchor) { Report(TEXT("No Ortho Earth Anchor in the level. Add one (Place Actors: Ortho Earth Anchor), set lon/lat/height and attach the model under it."), false); return; }
		IDesktopPlatform* DP = FDesktopPlatformModule::Get();
		TArray<FString> Files;
		if (!DP || !DP->SaveFileDialog(FSlateApplication::Get().FindBestParentWindowHandleForDialogs(nullptr), TEXT("Export GLB for ortho-earth"), FPaths::ProjectSavedDir(), Actors[0]->GetActorLabel() + TEXT(".glb"), TEXT("GLB (*.glb)|*.glb"), EFileDialogFlags::None, Files) || Files.Num() == 0) return;
		FString Log;
		const bool bOk = OrthoEarth::ExportSelection(Actors, Anchor, Files[0], Log);
		Report(Log, bOk);
	}

	void RegisterMenus()
	{
		FToolMenuOwnerScoped Owner(this);
		UToolMenu* Menu = UToolMenus::Get()->ExtendMenu("LevelEditor.MainMenu.Tools");
		FToolMenuSection& S = Menu->FindOrAddSection("OrthoEarth", LOCTEXT("Section", "Ortho Earth"));
		S.AddMenuEntry("OrthoEarthPlace", LOCTEXT("Place", "Place export folder…"), LOCTEXT("PlaceTip", "Put an ortho-export folder (anchor.json, terrain.glb, buildings.glb, *.las) into this level under an Ortho Earth Anchor"),
			FSlateIcon(), FUIAction(FExecuteAction::CreateStatic(&FOrthoEarthEditorModule::Place)));
		S.AddMenuEntry("OrthoEarthExport", LOCTEXT("Export", "Export selection to GLB…"), LOCTEXT("ExportTip", "Write the selected actors as a GLB with their anchor in asset.extras.orthoEarth (for www.ortho-earth.com)"),
			FSlateIcon(), FUIAction(FExecuteAction::CreateStatic(&FOrthoEarthEditorModule::Export)));
	}
};

IMPLEMENT_MODULE(FOrthoEarthEditorModule, OrthoEarthEditor)

#undef LOCTEXT_NAMESPACE
