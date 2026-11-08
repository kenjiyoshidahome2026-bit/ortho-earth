using UnrealBuildTool;

public class OrthoEarthEditor : ModuleRules
{
	public OrthoEarthEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[]
		{
			"OrthoEarthRuntime",
			"UnrealEd", "LevelEditor", "ToolMenus", "Slate", "SlateCore", "DesktopPlatform", "AssetTools", "AssetRegistry",
			"Json",
			"InterchangeCore", "InterchangeEngine",   // glTF import (Interchange's ImportScene = "Import into Level")
			"GLTFExporter",                            // Unreal → GLB
		});
		// The LiDAR Point Cloud plugin is optional: LAS files are imported through AssetTools and spawned through the actor factory,
		// so this module never links against it.
	}
}
