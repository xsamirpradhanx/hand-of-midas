import {
  ISeriesPrimitive,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

export interface PredictiveZone {
  type: 'buy' | 'sell';
  priceTop: number;
  priceBottom: number;
  convictionScore: number;
}

class ZoneRenderer implements IPrimitivePaneRenderer {
  private _zones: PredictiveZone[];
  private _series: any;
  private _startTime: Time | null = null;
  private _endTime: Time | null = null;
  private _chart: any;

  constructor(zones: PredictiveZone[], series: any, startTime: Time, endTime: Time, chart: any) {
    this._zones = zones;
    this._series = series;
    this._startTime = startTime;
    this._endTime = endTime;
    this._chart = chart;
  }

  draw(target: any) {
    target.useBitmapCoordinateSpace((scope: any) => {
      const ctx = scope.context;
      const horizontalPixelRatio = scope.horizontalPixelRatio;
      const verticalPixelRatio = scope.verticalPixelRatio;

      const timeScale = this._chart.timeScale();
      // Find x-coordinates
      let xStart = timeScale.timeToCoordinate(this._startTime as any) || 0;
      let xEnd = timeScale.timeToCoordinate(this._endTime as any) || scope.mediaSize.width;
      
      // If times are out of view or null, default to covering the right side
      if (!this._startTime) xStart = scope.mediaSize.width * 0.75;
      
      const x1 = Math.round(xStart * horizontalPixelRatio);
      const x2 = Math.round(xEnd * horizontalPixelRatio);
      const width = x2 - x1;

      if (width <= 0) return;

      for (const zone of this._zones) {
        const yTop = this._series.priceToCoordinate(zone.priceTop);
        const yBottom = this._series.priceToCoordinate(zone.priceBottom);

        if (yTop === null || yBottom === null || yTop === undefined || yBottom === undefined) continue;

        const y1 = Math.round(Math.min(yTop, yBottom) * verticalPixelRatio);
        const y2 = Math.round(Math.max(yTop, yBottom) * verticalPixelRatio);
        const height = Math.max(1, y2 - y1);

        const alpha = Math.max(0.1, Math.min(0.8, zone.convictionScore * 0.5));
        
        ctx.fillStyle = zone.type === 'buy' 
          ? `rgba(0, 255, 0, ${alpha})`
          : `rgba(255, 0, 0, ${alpha})`;
          
        ctx.fillRect(x1, y1, width, height);
        
        // Add borders
        ctx.strokeStyle = zone.type === 'buy' 
          ? `rgba(0, 255, 0, ${alpha + 0.2})`
          : `rgba(255, 0, 0, ${alpha + 0.2})`;
        ctx.lineWidth = 1 * horizontalPixelRatio;
        ctx.strokeRect(x1, y1, width, height);
      }
    });
  }
}

class ZonePaneView implements IPrimitivePaneView {
  private _plugin: ZonePlugin;

  constructor(plugin: ZonePlugin) {
    this._plugin = plugin;
  }

  zOrder(): 'bottom' | 'normal' | 'top' {
    return 'normal';
  }

  renderer(): IPrimitivePaneRenderer {
    return new ZoneRenderer(
      this._plugin.zones,
      this._plugin.series,
      this._plugin.startTime!,
      this._plugin.endTime!,
      this._plugin.chart
    );
  }
}

export class ZonePlugin implements ISeriesPrimitive {
  private _paneViews: ZonePaneView[];
  public series: any = null;
  public zones: PredictiveZone[] = [];
  public startTime: Time | null = null;
  public endTime: Time | null = null;
  public chart: any;

  constructor(chart: any) {
    this.chart = chart;
    this._paneViews = [new ZonePaneView(this)];
  }

  updateZones(zones: PredictiveZone[], startTime: Time, endTime: Time) {
    this.zones = zones;
    this.startTime = startTime;
    this.endTime = endTime;
    this.requestUpdate();
  }

  attached({ series, requestUpdate }: SeriesAttachedParameter) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = () => {};
  }

  requestUpdate: () => void = () => {};

  paneViews() {
    return this._paneViews;
  }

  autoscaleInfo() {
    if (!this.zones || this.zones.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const z of this.zones) {
      if (z.priceBottom < min) min = z.priceBottom;
      if (z.priceTop > max) max = z.priceTop;
    }
    if (min === Infinity || max === -Infinity) return null;
    
    // Add 5% padding
    const padding = (max - min) * 0.05;
    return {
      priceRange: {
        minValue: min - padding,
        maxValue: max + padding,
      },
    };
  }

  updateAllViews() {}
}
