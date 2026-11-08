#include "OrthoEarthBuildingComponent.h"
#include "OrthoEarthAttributeTable.h"

double UOrthoEarthBuildingComponent::MeasuredHeight() const
{
	for (const TPair<FString, FString>& P : Attributes)
		if (P.Key.EndsWith(TEXT("measuredHeight")) && P.Value.IsNumeric()) return FCString::Atod(*P.Value);
	return -1;
}
