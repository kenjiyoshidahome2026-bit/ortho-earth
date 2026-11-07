// .ply inside Assets/ → Mesh asset (points), so a point cloud from /japan/pointcloud can be dragged into a scene like any mesh.
using UnityEditor.AssetImporters;
using UnityEngine;

namespace OrthoEarth.Editor
{
	[ScriptedImporter(1, "ply")]
	public class PlyImporter : ScriptedImporter
	{
		[Tooltip("Flip Z (glTF frame Z south → Unity Z north). ortho-earth PLYs need this on")] public bool flipZ = true;

		public override void OnImportAsset(AssetImportContext ctx)
		{
			var mesh = PlyLoader.Load(ctx.assetPath, flipZ);
			ctx.AddObjectToAsset("mesh", mesh);
			ctx.SetMainObject(mesh);
		}
	}
}
