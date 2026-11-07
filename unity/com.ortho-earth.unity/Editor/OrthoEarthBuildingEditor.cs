// Inspector of OrthoEarthBuilding: the building's PLATEAU attributes as a searchable list.
using UnityEditor;
using UnityEngine;

namespace OrthoEarth.Editor
{
	[CustomEditor(typeof(OrthoEarthBuilding))]
	[CanEditMultipleObjects]
	public class OrthoEarthBuildingEditor : UnityEditor.Editor
	{
		string _filter = "";
		Vector2 _scroll;

		public override void OnInspectorGUI()
		{
			DrawDefaultInspector();
			if (targets.Length != 1) return;
			var b = (OrthoEarthBuilding)target;
			if (b.table == null) { EditorGUILayout.HelpBox("No attribute table. Place the export folder again (Ortho Earth > Place export folder in scene…) with buildings.attributes.json next to buildings.glb.", MessageType.Info); return; }
			if (b.table.IndexOf(b.id) < 0) { EditorGUILayout.HelpBox($"{b.id} is not in {b.table.name}.", MessageType.Warning); return; }
			EditorGUILayout.Space();
			EditorGUILayout.LabelField("Attributes", EditorStyles.boldLabel);
			_filter = EditorGUILayout.TextField("Filter", _filter);
			_scroll = EditorGUILayout.BeginScrollView(_scroll, GUILayout.MaxHeight(480));
			foreach (var kv in b.Attributes)
			{
				if (_filter.Length > 0 && kv.Key.IndexOf(_filter, System.StringComparison.OrdinalIgnoreCase) < 0 && kv.Value.IndexOf(_filter, System.StringComparison.OrdinalIgnoreCase) < 0) continue;
				EditorGUILayout.BeginHorizontal();
				EditorGUILayout.SelectableLabel(kv.Key, GUILayout.Width(EditorGUIUtility.labelWidth), GUILayout.Height(EditorGUIUtility.singleLineHeight));
				EditorGUILayout.SelectableLabel(kv.Value, GUILayout.Height(EditorGUIUtility.singleLineHeight));
				EditorGUILayout.EndHorizontal();
			}
			EditorGUILayout.EndScrollView();
			if (!string.IsNullOrEmpty(b.table.source)) EditorGUILayout.LabelField(b.table.source, EditorStyles.miniLabel);
		}
	}
}
