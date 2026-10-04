import {
  FACILITY_DISPLAY_SCALE_DEFAULT,
  FACILITY_DISPLAY_SCALE_MAX,
  FACILITY_DISPLAY_SCALE_MIN,
  clampFacilityDisplayScale,
} from "./facilityDisplay";
import "./FacilityDisplaySettings.css";

type FacilityDisplaySettingsProps = {
  value: number;
  onChange: (value: number) => void;
};

/** 只调整地图符号像素大小，不改变设施实际尺寸或几何。 */
export function FacilityDisplaySettings({
  value,
  onChange,
}: FacilityDisplaySettingsProps) {
  const scale = clampFacilityDisplayScale(value);
  return (
    <section
      className="facility-display-settings"
      aria-labelledby="facility-display-title"
    >
      <div className="facility-display-settings__heading">
        <strong id="facility-display-title">地图符号大小</strong>
        <output htmlFor="facility-display-scale">{scale.toFixed(2)}×</output>
      </div>
      <input
        id="facility-display-scale"
        aria-label="设施地图符号显示倍率"
        type="range"
        min={FACILITY_DISPLAY_SCALE_MIN}
        max={FACILITY_DISPLAY_SCALE_MAX}
        step={0.05}
        value={scale}
        onChange={(event) =>
          onChange(clampFacilityDisplayScale(Number(event.currentTarget.value)))
        }
      />
      <div className="facility-display-settings__footer">
        <span>符号大小仅影响显示，非真实尺寸</span>
        <button
          type="button"
          onClick={() => onChange(FACILITY_DISPLAY_SCALE_DEFAULT)}
          disabled={scale === FACILITY_DISPLAY_SCALE_DEFAULT}
        >
          重置
        </button>
      </div>
    </section>
  );
}
