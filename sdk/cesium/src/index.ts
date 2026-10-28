// @ortho-earth/cesium — the CesiumJS API on the ortho-earth globe.
//   import * as Cesium from "@ortho-earth/cesium" is the Cesium namespace (@cesium/core + @cesium/engine + @cesium/widgets, unchanged) with the parts
//   that render replaced: Viewer and CesiumWidget build a WebGL-free Scene whose camera, entities, imagery and 3D Tiles are drawn by @ortho-earth/globe.
//   Math, time, Entity/Property, CZML/GeoJSON/KML parsing, the camera's flights and the widgets are the engine's own code.
//   What has no counterpart on the globe is reported once as "[csshim] unsupported: …" and never throws (unsupportedReport() lists it).
export * from "@cesium/engine";
// names: (scripts/names.mjs)
export {
	ArcType, AssociativeArray, AttributeCompression, AttributeType, AxisAlignedBoundingBox, BoundingRectangle, BoundingSphere, BoxGeometry,
	BoxOutlineGeometry, Cartesian2, Cartesian3, Cartesian4, Cartographic, CatmullRomSpline, Check, CircleGeometry, CircleOutlineGeometry, Clock,
	ClockRange, ClockStep, Color, ColorGeometryInstanceAttribute, ComponentDatatype, ConstantSpline, CoplanarPolygonGeometry,
	CoplanarPolygonOutlineGeometry, CornerType, CorridorGeometry, CorridorOutlineGeometry, CubicRealPolynomial, CullingVolume, CylinderGeometry,
	CylinderOutlineGeometry, DeveloperError, DistanceDisplayCondition, DistanceDisplayConditionGeometryInstanceAttribute, EllipseGeometry,
	EllipseOutlineGeometry, Ellipsoid, EllipsoidGeodesic, EllipsoidGeometry, EllipsoidOutlineGeometry, EllipsoidRhumbLine, EllipsoidTangentPlane,
	EllipsoidalOccluder, EncodedCartesian3, Event, EventHelper, ExtrapolationType, FixedFrameTransforms, Frozen, GeographicProjection, Geometry,
	GeometryAttribute, GeometryAttributes, GeometryFactory, GeometryInstance, GeometryInstanceAttribute, GeometryOffsetAttribute, GeometryPipeline,
	GregorianDate, HeadingPitchRange, HeadingPitchRoll, HermitePolynomialApproximation, HermiteSpline, HilbertOrder, IndexDatatype, InterpolationType,
	Intersect, IntersectionTests, Intersections2D, Interval, Iso8601, JulianDate, LagrangePolynomialApproximation, LeapSecond, LinearApproximation,
	LinearSpline, Math, Matrix2, Matrix3, Matrix4, MorphWeightSpline, NearFarScalar, Occluder, OrientedBoundingBox, OrthographicFrustum,
	OrthographicOffCenterFrustum, Packable, PackableForInterpolation, PerspectiveFrustum, PerspectiveOffCenterFrustum, PixelDatatype, PixelFormat, Plane,
	PlaneGeometry, PlaneOutlineGeometry, PolygonGeometry, PolygonHierarchy, PolygonOutlineGeometry, PolygonPipeline, PolylineGeometry, PolylinePipeline,
	PolylineVolumeGeometry, PolylineVolumeOutlineGeometry, PrimitiveType, QuadraticRealPolynomial, QuarticRealPolynomial, Quaternion, QuaternionSpline,
	Queue, Ray, Rectangle, RectangleGeometry, RectangleOutlineGeometry, ReferenceFrame, RuntimeError, ShowGeometryInstanceAttribute,
	SimplePolylineGeometry, SphereGeometry, SphereOutlineGeometry, Spherical, Spline, SteppedSpline, Stereographic, TimeConstants, TimeInterval,
	TimeIntervalCollection, TimeStandard, TrackingReferenceFrame, TranslationRotationScale, TridiagonalSystemSolver, VertexFormat, VerticalExaggeration,
	Visibility, WallGeometry, WallOutlineGeometry, WebGLConstants, WebMercatorProjection, WindingOrder, addAllToArray, arrayRemoveDuplicates, assert,
	barycentricCoordinates, binarySearch, clone, combine, createGuid, defined, deprecationWarning, destroyObject, formatError, getAbsoluteUri, getBaseUri,
	getExtensionFromUri, getFilenameFromUri, getJsonFromTypedArray, getMagic, getStringFromTypedArray, getTimestamp, isLeapYear, mergeSort, objectToQuery,
	oneTimeWarning, pointInsideTriangle, queryToObject, srgbToLinear, subdivideArray,
	// @ts-ignore -- not in the d.ts
	CoplanarPolygonGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	CorridorGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	CylinderGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	EllipseGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	GeometryType,
	// @ts-ignore -- not in the d.ts
	MapProjection,
	// @ts-ignore -- not in the d.ts
	PolygonGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	PolylineVolumeGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	RectangleGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	Tipsify,
	// @ts-ignore -- not in the d.ts
	WallGeometryLibrary,
	// @ts-ignore -- not in the d.ts
	scaleToGeodeticSurface,
} from "@cesium/core";
export {
	Animation, AnimationViewModel, BaseLayerPicker, BaseLayerPickerViewModel, Cesium3DTilesInspector, Cesium3DTilesInspectorViewModel, CesiumInspector,
	CesiumInspectorViewModel, ClockViewModel, Command, FullscreenButton, FullscreenButtonViewModel, Geocoder, GeocoderViewModel, HomeButton,
	HomeButtonViewModel, I3SBuildingSceneLayerExplorer, InfoBox, InfoBoxViewModel, NavigationHelpButton, NavigationHelpButtonViewModel,
	PerformanceWatchdog, PerformanceWatchdogViewModel, ProjectionPicker, ProjectionPickerViewModel, ProviderViewModel, SceneModePicker,
	SceneModePickerViewModel, SelectionIndicator, SelectionIndicatorViewModel, SvgPathBindingHandler, Timeline, ToggleButtonViewModel, VRButton,
	VRButtonViewModel, VoxelInspector, VoxelInspectorViewModel, createCommand, knockout, viewerCesium3DTilesInspectorMixin, viewerCesiumInspectorMixin,
	viewerDragDropMixin, viewerPerformanceWatchdogMixin, viewerVoxelInspectorMixin,
	// @ts-ignore -- not in the d.ts
	I3SBuildingSceneLayerExplorerViewModel,
	// @ts-ignore -- not in the d.ts
	InspectorShared,
	// @ts-ignore -- not in the d.ts
	TimelineHighlightRange,
	// @ts-ignore -- not in the d.ts
	TimelineTrack,
	// @ts-ignore -- not in the d.ts
	createDefaultImageryProviderViewModels,
	// @ts-ignore -- not in the d.ts
	createDefaultTerrainProviderViewModels,
	// @ts-ignore -- not in the d.ts
	knockout_3_5_1,
	// @ts-ignore -- not in the d.ts
	knockout_es5,
	// @ts-ignore -- not in the d.ts
	subscribeAndEvaluate,
} from "@cesium/widgets";
// :names
export { Viewer, CesiumWidget } from "./viewer.ts";
export { Cesium3DTileset, Cesium3DTileFeature } from "./tileset.ts";
export { I3SDataProvider } from "./i3s.ts";
export { createOsmBuildingsAsync, createGooglePhotorealistic3DTileset, createWorldTerrainAsync } from "./create.ts";
export { unsupportedReport } from "./report.ts";
