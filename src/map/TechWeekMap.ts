import maplibregl, { type GeoJSONSource, type LngLatLike, type Map as MLMap, type Marker, type Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DAY_COLORS, MOBILE_BREAKPOINT, dayColor, type Camera, type LngLat } from "../data/cities";
import { SPEED, whenLabel, type Home, type TravelMode, type TWEvent } from "../lib/events";

const STYLE_DAY = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const STYLE_NIGHT = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
// Keyless fallback (same OpenMapTiles schema, so buildings and layers keep working).
const FALLBACK_DAY = "https://tiles.openfreemap.org/styles/positron";
const FALLBACK_NIGHT = "https://tiles.openfreemap.org/styles/dark";

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface EventProps {
  id: number;
  day: string;
  title: string;
  host: string;
  hood: string;
  when: string;
  url: string;
  n?: number;
}
type EventFeature = GeoJSON.Feature<GeoJSON.Point, EventProps>;

export interface PlanStop {
  e: TWEvent;
  n: number;
}
export interface PlanLeg {
  from: LngLat;
  to: LngLat;
  day: string;
  walk: boolean;
  label: string;
}

/** Everything the map needs to read from, or tell, the React app. */
export interface MapHost {
  getCam(): Camera;
  isNight(): boolean;
  getPlanIds(): number[];
  getEvent(id: number): TWEvent | undefined;
  togglePlan(id: number): void;
  isOrbiting(): boolean;
  setOrbiting(on: boolean): void;
  hideTags(): boolean;
  /** Screen area not covered by side panels, in map-canvas pixels. */
  labelBounds(canvasRect: DOMRect, width: number): { left: number; right: number; top: number };
  /** Camera padding that keeps framed content clear of the side panels. */
  framePadding(): { top: number; bottom: number; left: number; right: number };
  onLoaded(): void;
  onError(msg: string): void;
}

const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const dayColorExpr = (): maplibregl.ExpressionSpecification => [
  "match", ["get", "day"],
  "Mon", DAY_COLORS.Mon, "Tue", DAY_COLORS.Tue, "Wed", DAY_COLORS.Wed, "Thu", DAY_COLORS.Thu,
  "Fri", DAY_COLORS.Fri, "Sat", DAY_COLORS.Sat, "Sun", DAY_COLORS.Sun,
  "#8e8e93",
];

const HEIGHT: maplibregl.ExpressionSpecification = ["coalesce", ["to-number", ["get", "render_height"]], ["to-number", ["get", "height"]], 15];

function toFeature(e: TWEvent, extra?: Partial<EventProps>): EventFeature | null {
  if (!e.xy) return null;
  return {
    type: "Feature",
    properties: { id: e.id, day: e.day, title: e.title, host: e.host, hood: e.hood, when: whenLabel(e), url: e.url, ...extra },
    geometry: { type: "Point", coordinates: e.xy },
  };
}

/** "6pm · AI Demo Night": time plus the title cut at the first | : ( and capped at 22 chars. */
function labelText(p: EventProps) {
  const m = /(\d+)(?::(\d+))?\s*(am|pm)/i.exec(p.when || "");
  const t = m ? m[1] + (m[2] && m[2] !== "00" ? ":" + m[2] : "") + m[3].toLowerCase() : "";
  let ti = String(p.title || "").split(/[|:(]/)[0].trim();
  if (ti.length > 22) ti = ti.slice(0, 21).trim() + "…";
  const tt = /TBA/.test(p.when || "") ? "TBA" : t;
  return (tt ? tt + " · " : "") + ti;
}

const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

type LabelMarker = Marker & { _slot?: string };

export class TechWeekMap {
  private map: MLMap;
  private loaded = false;
  private disposed = false;
  private host: MapHost;
  private container: HTMLElement;

  private eventsFC: GeoJSON.FeatureCollection<GeoJSON.Point, EventProps> = EMPTY_FC as never;
  private planPts: GeoJSON.FeatureCollection = EMPTY_FC;
  private planRoute: GeoJSON.FeatureCollection = EMPTY_FC;

  private popup: Popup | null = null;
  private labels = new Map<string, LabelMarker>();
  private hoverMarker: Marker | null = null;
  private hoverId: string | null = null;
  private labelSig = "";
  private labelTimer = 0;
  private labelDebounce = 0;
  private orbitRaf = 0;
  private orbitSpeed = 1;
  private orbitDir = 1;
  private orbitSelfMove = false;
  private resumeTimer = 0;
  private ro: ResizeObserver;
  /** Last event opened in a popup; its label is always kept. */
  private selId: string | null = null;
  private home: Home | null = null;
  private mode: TravelMode = "walk";
  private youMarker: Marker | null = null;
  private useFallback = false;
  private styleOk = false;
  private loadGuard = 0;

  private styleUrl() {
    const night = this.host.isNight();
    if (this.useFallback) return night ? FALLBACK_NIGHT : FALLBACK_DAY;
    return night ? STYLE_NIGHT : STYLE_DAY;
  }

  constructor(container: HTMLElement, host: MapHost) {
    this.container = container;
    this.host = host;
    const cam = host.getCam();
    this.map = new maplibregl.Map({
      container,
      style: host.isNight() ? STYLE_NIGHT : STYLE_DAY,
      center: cam.center,
      zoom: cam.zoom,
      pitch: cam.pitch,
      bearing: cam.bearing,
      maxPitch: 75,
      antialias: true,
      attributionControl: { compact: true },
    });

    // The canvas can come up at the wrong size if the container was still laying out.
    const fit = () => {
      const cv = this.map.getCanvas();
      if (Math.abs(cv.clientWidth - container.clientWidth) > 1 || Math.abs(cv.clientHeight - container.clientHeight) > 1) {
        this.map.resize();
        this.updateLabels(true);
      }
    };
    this.ro = new ResizeObserver(fit);
    this.ro.observe(container);
    requestAnimationFrame(fit);
    setTimeout(fit, 300);
    setTimeout(fit, 1200);

    // Start with the compact attribution collapsed (MapLibre opens it on wide screens).
    const collapseAttrib = () => {
      const el = container.querySelector(".maplibregl-ctrl-attrib");
      if (el) {
        el.classList.remove("maplibregl-compact-show");
        el.removeAttribute("open");
      }
    };
    this.map.once("load", collapseAttrib);
    this.map.once("idle", collapseAttrib);
    setTimeout(collapseAttrib, 800);
    setTimeout(collapseAttrib, 2500);

    this.map.on("load", () => {
      this.loaded = true;
      this.map.resize();
      try {
        this.setupLayers();
        this.bindEvents();
        this.startOrbitLoop();
      } catch (e) {
        console.warn("map setup error", e);
      }
      host.onLoaded();
    });
    this.map.on("styledata", () => {
      this.styleOk = true;
    });
    // Only a basemap STYLE that can't be fetched is fatal. Individual tile, glyph or sprite
    // failures (common on flaky networks, CDN hiccups or rate limits) are logged and ignored,
    // and any error after the first successful load is never shown as a failure screen.
    this.map.on("error", (e) => {
      const err = (e as unknown as { error?: { message?: string; url?: string; status?: number }; tile?: unknown; sourceId?: string }) || {};
      const msg = String(err.error?.message || err.error || "");
      const url = String(err.error?.url || "");
      const isTile = !!(err.tile || err.sourceId) || /\/(tiles?|fonts?|sprites?)\//i.test(url) || /\.(pbf|mvt|png|webp|jpg)(\?|$)/i.test(url);
      if (isTile || this.loaded || this.styleOk) {
        console.warn("[map] non-fatal:", url || msg);
        return;
      }
      if (this.switchToFallback()) return;
      host.onError("The basemap couldn't be reached. Check your connection and retry.");
    });
    this.loadGuard = window.setTimeout(() => {
      if (this.disposed || this.loaded || this.styleOk) return;
      if (!this.switchToFallback()) host.onError("The basemap couldn't be reached. Check your connection and retry.");
    }, 15000);
  }

  private switchToFallback() {
    if (this.useFallback || this.disposed) return false;
    this.useFallback = true;
    console.warn("[map] primary basemap unreachable, switching to OpenFreeMap");
    try {
      this.map.setStyle(this.styleUrl());
      return true;
    } catch {
      return false;
    }
  }

  destroy() {
    this.disposed = true;
    clearTimeout(this.loadGuard);
    cancelAnimationFrame(this.orbitRaf);
    clearInterval(this.labelTimer);
    clearTimeout(this.labelDebounce);
    clearTimeout(this.resumeTimer);
    this.ro.disconnect();
    try {
      this.map.remove();
    } catch {
      /* already gone */
    }
  }

  // ---------- public API ----------

  setEvents(list: TWEvent[]) {
    const feats: EventFeature[] = [];
    for (const e of list) {
      const f = toFeature(e);
      if (f) feats.push(f);
    }
    this.eventsFC = { type: "FeatureCollection", features: feats };
    (this.map.getSource("events") as GeoJSONSource | undefined)?.setData(this.eventsFC);
    this.updateLabels(true);
  }

  setPlan(stops: PlanStop[], legs: PlanLeg[]) {
    this.planPts = {
      type: "FeatureCollection",
      features: stops.map((s) => toFeature(s.e, { n: s.n })).filter(Boolean) as EventFeature[],
    };
    this.planRoute = {
      type: "FeatureCollection",
      features: legs.map((l) => ({
        type: "Feature",
        properties: { day: l.day, walk: l.walk, label: l.label },
        geometry: { type: "LineString", coordinates: [l.from, l.to] },
      })),
    };
    (this.map.getSource("plan-pts") as GeoJSONSource | undefined)?.setData(this.planPts);
    (this.map.getSource("plan-route") as GeoJSONSource | undefined)?.setData(this.planRoute);
    this.updateLabels(true);
  }

  /** Home base: "You" pin plus dashed 10 / 20 / 30 min travel rings at the chosen mode. */
  setHome(home: Home | null, mode: TravelMode) {
    this.home = home;
    this.mode = mode;
    this.syncHome();
  }

  /** Ease to the home base without changing zoom much. */
  easeToHome(xy: LngLat) {
    const p = this.host.framePadding();
    this.map.easeTo({
      center: xy,
      zoom: Math.max(13.6, Math.min(this.map.getZoom(), 14.6)),
      duration: 1400,
      padding: isMobile() ? { top: 120, bottom: 120, left: 20, right: 20 } : { top: 60, bottom: 80, left: p.left + 10, right: p.right + 10 },
    });
  }

  /** Reloads the basemap for the host's current theme. */
  applyTheme() {
    if (!this.loaded) return;
    this.closePopup();
    // A full reload (diff: false): diffing the two CARTO styles drops our custom layers.
    this.map.once("style.load", () => {
      try {
        this.setupLayers();
      } catch (e) {
        console.error("theme swap", e);
      }
    });
    this.map.setStyle(this.styleUrl(), { diff: false });
    setTimeout(() => this.updateLabels(true), 50);
  }

  setOrbit(speed: number, dir: number) {
    this.orbitSpeed = speed;
    this.orbitDir = dir;
  }

  flyToCam(cam: Camera, duration = 3200, curve = 1.6) {
    this.closePopup();
    this.map.flyTo({ ...cam, duration, curve, essential: true });
  }

  jumpToCam(cam: Camera) {
    this.map.jumpTo(cam);
  }

  refreshLabels() {
    this.updateLabels(true);
  }

  /** Camera move after a filter change: zoom into the densest cluster of matches, or home when unfiltered. */
  frameEvents(isDefault: boolean) {
    const map = this.map;
    this.closePopup();
    clearTimeout(this.resumeTimer);
    const fc = this.eventsFC;
    const resume = this.host.isOrbiting();
    if (resume) this.host.setOrbiting(false);
    const done = () => {
      if (resume) this.resumeTimer = window.setTimeout(() => this.host.setOrbiting(true), 600);
    };
    if (isDefault || !fc.features.length) {
      map.flyTo({ ...this.host.getCam(), duration: 2400, curve: 1.3, easing: easeOutCubic, essential: true });
      map.once("moveend", done);
      return;
    }
    const cells: Record<string, number> = {};
    for (const f of fc.features) {
      const [x, y] = f.geometry.coordinates;
      const k = Math.round(x / 0.008) + ":" + Math.round(y / 0.008);
      cells[k] = (cells[k] || 0) + 1;
    }
    let bestK: [number, number] = [0, 0], best = -1;
    for (const k in cells) {
      const [cx, cy] = k.split(":").map(Number);
      let sc = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) sc += cells[cx + dx + ":" + (cy + dy)] || 0;
      if (sc > best) {
        best = sc;
        bestK = [cx * 0.008, cy * 0.008];
      }
    }
    const R = 0.016;
    const near = fc.features.filter((f) => Math.abs(f.geometry.coordinates[0] - bestK[0]) < R * 1.27 && Math.abs(f.geometry.coordinates[1] - bestK[1]) < R);
    const pool = near.length ? near : fc.features;
    const xs = pool.map((f) => f.geometry.coordinates[0]).sort((a, b) => a - b);
    const ys = pool.map((f) => f.geometry.coordinates[1]).sort((a, b) => a - b);
    const q = (arr: number[], t: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * t)))];
    const trim = pool.length > 12 ? 0.08 : 0;
    let w = q(xs, trim), ea = q(xs, 1 - trim), so = q(ys, trim), no = q(ys, 1 - trim);
    const minSpan = 0.004;
    if (ea - w < minSpan) {
      const c = (ea + w) / 2;
      w = c - minSpan / 2;
      ea = c + minSpan / 2;
    }
    if (no - so < minSpan * 0.8) {
      const c = (no + so) / 2;
      so = c - minSpan * 0.4;
      no = c + minSpan * 0.4;
    }
    const target = map.cameraForBounds([[w, so], [ea, no]], { padding: this.host.framePadding(), maxZoom: 16.6, bearing: map.getBearing() });
    if (!target) return done();
    // Always zoom in, never out: repeated filter picks keep getting closer, up to a cap.
    const z = Math.min(Math.max(target.zoom ?? 14.6, map.getZoom() + 0.4, 14.6), 16.6);
    const pitch = z > 15 ? 64 : z > 13.5 ? 58 : 48;
    map.flyTo({ center: target.center, zoom: z, pitch, bearing: map.getBearing() + 22, duration: 2600, curve: 1.25, speed: 0.9, easing: easeOutCubic, essential: true });
    map.once("moveend", done);
  }

  /** Fit one day's planned stops. */
  framePoints(pts: LngLat[]) {
    const map = this.map;
    if (!pts.length) return;
    let w = 180, e = -180, s = 90, n = -90;
    for (const [x, y] of pts) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      n = Math.max(n, y);
    }
    const pad = 0.0025;
    w -= pad;
    e += pad;
    s -= pad * 0.8;
    n += pad * 0.8;
    const p = this.host.framePadding();
    const cam = map.cameraForBounds([[w, s], [e, n]], { padding: { ...p, bottom: p.bottom + 20 }, maxZoom: 16.4, bearing: map.getBearing() });
    if (!cam) return;
    this.host.setOrbiting(false);
    setTimeout(
      () => map.flyTo({ center: cam.center, zoom: Math.min(cam.zoom ?? 16.4, 16.4), pitch: 58, bearing: map.getBearing() + 15, duration: 2400, curve: 1.3, easing: easeOutCubic, essential: true }),
      30,
    );
  }

  // ---------- layers ----------

  private setupLayers() {
    this.themeBasemap();
    this.addBuildings();
    this.addEventLayers();
    this.addHomeLayers();
    this.addPlanLayers();
    this.syncHome();
    this.updateLabels(true);
  }

  private themeBasemap() {
    const map = this.map;
    const night = this.host.isNight();
    if (night) map.setLight({ color: "#cfd8ff", intensity: 0.4, anchor: "viewport", position: [1.3, 210, 30] });
    else map.setLight({ color: "#ffffff", intensity: 0.25, anchor: "viewport", position: [1.15, 210, 30] });
    for (const lyr of map.getStyle().layers) {
      if (lyr.type === "background") map.setPaintProperty(lyr.id, "background-color", night ? "#0a0f1c" : "#e8e6df");
      if (lyr.type === "fill" && /water/i.test(lyr.id)) map.setPaintProperty(lyr.id, "fill-color", night ? "#0c1526" : "#a9c7dd");
      if (lyr.type === "fill" && /(park|green|wood|grass|cemetery|pitch|garden|landcover)/i.test(lyr.id)) map.setPaintProperty(lyr.id, "fill-color", night ? "#0c1a12" : "#9ccf83");
      // Declutter: hide boundaries, rail, ferries, POIs and minor labels.
      if (/boundary|admin|rail|transit|ferry|aeroway|tunnel|path|track|casing|pattern|oneway/i.test(lyr.id) && (lyr.type === "line" || lyr.type === "symbol"))
        map.setLayoutProperty(lyr.id, "visibility", "none");
      if (lyr.type === "symbol" && /poi|housenumber|waterway.label|road_label|highway.label|minor/i.test(lyr.id)) map.setLayoutProperty(lyr.id, "visibility", "none");
    }
  }

  private buildingColor(): maplibregl.ExpressionSpecification {
    return this.host.isNight()
      ? ["interpolate", ["linear"], HEIGHT, 0, "#232c3e", 15, "#2b364c", 50, "#38425c", 100, "#55506a", 180, "#8a6a45", 320, "#e8a04e"]
      : ["interpolate", ["linear"], HEIGHT, 0, "#eeeade", 30, "#e3ded2", 80, "#ccd3d9", 150, "#a8bccd", 250, "#84a4c2", 400, "#6d90b3"];
  }

  private addBuildings() {
    const map = this.map;
    let src: string | null = null;
    for (const lyr of map.getStyle().layers) {
      if ("source-layer" in lyr && lyr["source-layer"] === "building") {
        src = lyr.source;
        if (lyr.type === "fill") map.setLayoutProperty(lyr.id, "visibility", "none");
      }
    }
    if (!src || map.getLayer("bld-3d")) return;
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol");
    map.addLayer(
      {
        id: "bld-3d",
        type: "fill-extrusion",
        source: src,
        "source-layer": "building",
        minzoom: 10,
        paint: {
          "fill-extrusion-color": this.buildingColor(),
          // Real height up to 40 m, then 30% of the excess, hard-capped at 90 m, so towers don't dominate.
          "fill-extrusion-height": ["min", ["+", ["min", HEIGHT, 40], ["*", ["max", ["-", HEIGHT, 40], 0], 0.3]], 90],
          "fill-extrusion-base": ["coalesce", ["to-number", ["get", "render_min_height"]], 0],
          "fill-extrusion-opacity": 1,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      firstSymbol?.id,
    );
    // Keep every basemap road/line/fill layer under the extrusions so nothing stripes across rooftops.
    const order = map.getStyle().layers.map((l) => l.id);
    for (let i = order.indexOf("bld-3d") + 1; i < order.length; i++) {
      const lyr = map.getLayer(order[i]);
      if (lyr && lyr.type !== "symbol") map.moveLayer(order[i], "bld-3d");
    }
  }

  private addEventLayers() {
    const map = this.map;
    if (map.getSource("events")) return;
    map.addSource("events", { type: "geojson", data: this.eventsFC });
    map.addLayer({
      id: "events-halo",
      type: "circle",
      source: "events",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 4, 16, 10], "circle-color": dayColorExpr(), "circle-opacity": 0.28, "circle-blur": 0.6 },
    });
    map.addLayer({
      id: "events-dot",
      type: "circle",
      source: "events",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.2, 16, 5],
        "circle-color": dayColorExpr(),
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 1.5],
        "circle-stroke-color": "#ffffff",
      },
    });
  }

  private addHomeLayers() {
    const map = this.map;
    if (map.getSource("home-rings")) return;
    const symbolWithFont = map.getStyle().layers.find((l) => l.type === "symbol" && l.layout && (l.layout as Record<string, unknown>)["text-font"]);
    const font = ((symbolWithFont?.layout as Record<string, unknown> | undefined)?.["text-font"] as string[]) || ["Open Sans Regular"];
    map.addSource("home-rings", { type: "geojson", data: EMPTY_FC });
    map.addSource("home-ring-lbl", { type: "geojson", data: EMPTY_FC });
    // Under the event dots.
    map.addLayer({ id: "home-ring-fill", type: "fill", source: "home-rings", paint: { "fill-color": "#111111", "fill-opacity": 0.045 } }, "events-halo");
    map.addLayer({ id: "home-ring-line", type: "line", source: "home-rings", paint: { "line-color": "#111111", "line-opacity": 0.35, "line-width": 1.2, "line-dasharray": [2, 2] } }, "events-halo");
    map.addLayer({
      id: "home-ring-text",
      type: "symbol",
      source: "home-ring-lbl",
      layout: { "text-field": ["get", "t"], "text-font": font, "text-size": 10, "text-allow-overlap": true, "text-ignore-placement": true },
      paint: { "text-color": "#111111", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
    });
  }

  private syncHome() {
    const map = this.map;
    this.youMarker?.remove();
    this.youMarker = null;
    const rings = map.getSource("home-rings") as GeoJSONSource | undefined;
    const lbls = map.getSource("home-ring-lbl") as GeoJSONSource | undefined;
    if (!rings || !lbls) return;
    const night = this.host.isNight();
    const ink = night ? "#ffffff" : "#111111";
    map.setPaintProperty("home-ring-fill", "fill-color", ink);
    map.setPaintProperty("home-ring-line", "line-color", ink);
    map.setPaintProperty("home-ring-text", "text-color", ink);
    map.setPaintProperty("home-ring-text", "text-halo-color", night ? "#0a0f1c" : "#ffffff");
    const h = this.home;
    if (!h) {
      rings.setData(EMPTY_FC);
      lbls.setData(EMPTY_FC);
      return;
    }
    const sp = SPEED[this.mode], la = (h.xy[1] * Math.PI) / 180;
    const feats: GeoJSON.Feature[] = [], lf: GeoJSON.Feature[] = [];
    for (const m of [30, 20, 10]) {
      const r = (sp * m) / 60; // km
      const co: LngLat[] = [];
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        co.push([h.xy[0] + (Math.cos(a) * r) / (111.32 * Math.cos(la)), h.xy[1] + (Math.sin(a) * r) / 110.57]);
      }
      feats.push({ type: "Feature", properties: { m }, geometry: { type: "Polygon", coordinates: [co] } });
      lf.push({ type: "Feature", properties: { t: m + " min" }, geometry: { type: "Point", coordinates: [h.xy[0], h.xy[1] + r / 110.57] } });
    }
    rings.setData({ type: "FeatureCollection", features: feats });
    lbls.setData({ type: "FeatureCollection", features: lf });
    const el = document.createElement("div");
    el.className = "tw-you" + (night ? " is-night" : "");
    el.innerHTML = '<span>You</span><img src="/assets/you-pin.png" alt="">';
    this.youMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat(h.xy).addTo(map);
  }

  private addPlanLayers() {
    const map = this.map;
    if (map.getSource("plan-pts")) return;
    const symbolWithFont = map.getStyle().layers.find((l) => l.type === "symbol" && l.layout && (l.layout as Record<string, unknown>)["text-font"]);
    const font = ((symbolWithFont?.layout as Record<string, unknown> | undefined)?.["text-font"] as string[]) || ["Open Sans Regular"];
    const dayC = dayColorExpr();
    map.addSource("plan-route", { type: "geojson", data: this.planRoute });
    map.addSource("plan-pts", { type: "geojson", data: this.planPts });
    map.addLayer({ id: "plan-route-casing", type: "line", source: "plan-route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 } });
    map.addLayer({ id: "plan-route-drive", type: "line", source: "plan-route", filter: ["!", ["get", "walk"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dayC, "line-width": 4 } });
    map.addLayer({ id: "plan-route-walk", type: "line", source: "plan-route", filter: ["get", "walk"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": dayC, "line-width": 4, "line-dasharray": [1.2, 1.4] } });
    map.addLayer({
      id: "plan-route-label",
      type: "symbol",
      source: "plan-route",
      layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": font, "text-size": 12, "text-allow-overlap": true, "text-offset": [0, -1] },
      paint: { "text-color": "#111111", "text-halo-color": "#ffffff", "text-halo-width": 2.2 },
    });
    map.addLayer({
      id: "plan-ring",
      type: "circle",
      source: "plan-pts",
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 8, 16, 13], "circle-color": "#ffffff", "circle-stroke-color": dayC, "circle-stroke-width": 3.5 },
    });
    map.addLayer({
      id: "plan-num",
      type: "symbol",
      source: "plan-pts",
      layout: { "text-field": ["to-string", ["get", "n"]], "text-font": font, "text-size": 12, "text-allow-overlap": true, "text-ignore-placement": true },
      paint: { "text-color": "#111111" },
    });
  }

  // Layer-scoped handlers survive setStyle, so they are bound once.
  private bindEvents() {
    const map = this.map;
    for (const layer of ["events-dot", "plan-ring"]) {
      map.on("click", layer, (ev) => {
        const f = ev.features?.[0];
        if (f) this.openPopup(f as unknown as EventFeature);
      });
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        if (layer === "events-dot") this.hoverLabel(null);
      });
    }
    map.on("mousemove", "events-dot", (ev) => this.hoverLabel((ev.features?.[0] as unknown as EventFeature) || null));
    map.on("idle", () => {
      if (!this.labels.size) this.updateLabels(true);
    });
    // Labels refresh on a slow timer and after the camera settles, never every frame, so orbiting doesn't make them flicker.
    this.labelTimer = window.setInterval(() => {
      try {
        this.updateLabels();
      } catch (e) {
        console.warn("labels", e);
      }
    }, 1500);
    map.on("moveend", () => {
      clearTimeout(this.labelDebounce);
      this.labelDebounce = window.setTimeout(() => {
        const c = map.getCenter();
        const sig = Math.round(map.getZoom() * 5) + "|" + c.lng.toFixed(3) + "|" + c.lat.toFixed(3) + "|" + Math.round(map.getPitch() / 10);
        if (sig === this.labelSig) return;
        this.labelSig = sig;
        this.updateLabels();
      }, 350);
    });
    // Any direct interaction takes control away from the orbit.
    const stop = () => {
      if (this.host.isOrbiting()) this.host.setOrbiting(false);
    };
    map.on("mousedown", stop);
    map.on("touchstart", stop);
    map.on("wheel", stop);
    map.on("dragstart", stop);
  }

  private startOrbitLoop() {
    let last = performance.now();
    const step = (now: number) => {
      if (this.disposed) return;
      this.orbitRaf = requestAnimationFrame(step);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!this.host.isOrbiting() || (this.map.isMoving() && !this.orbitSelfMove)) return;
      this.orbitSelfMove = true;
      this.map.setBearing(this.map.getBearing() + this.orbitDir * 4 * this.orbitSpeed * dt);
      this.orbitSelfMove = false;
    };
    this.orbitRaf = requestAnimationFrame(step);
  }

  // ---------- popups ----------

  private closePopup() {
    this.popup?.remove();
    this.popup = null;
  }

  private openPopup(f: EventFeature) {
    const pr = f.properties;
    const id = +pr.id;
    this.selId = String(id);
    const inPlan = () => this.host.getPlanIds().includes(id);
    const btnText = () => (inPlan() ? "In your plan · Remove" : "+ Add to plan");
    const dc = dayColor(this.host.getEvent(id)?.day || pr.day, "#16181e");
    // Popup takes the day color; light days (Sat/Sun) get dark ink.
    const n = parseInt(dc.slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    const darkInk = lum > 0.6;
    const ink = darkInk ? "#111111" : "#ffffff", sub = darkInk ? "rgba(17,17,17,0.72)" : "rgba(255,255,255,0.82)";
    this.closePopup();
    this.popup = new maplibregl.Popup({ closeButton: false, offset: 12, maxWidth: "270px" })
      .setLngLat(f.geometry.coordinates as LngLatLike)
      .setHTML(
        '<div class="tw-pop" style="color:' + ink + '"><a href="' + escHtml(pr.url) + '" target="_blank" rel="noopener noreferrer" style="color:' + ink + '">' +
          '<span class="tw-pop-sub" style="color:' + sub + '">' + escHtml(pr.when) + "</span>" +
          '<span class="tw-pop-title">' + escHtml(pr.title) + "</span>" +
          '<span class="tw-pop-sub" style="color:' + sub + '">' + escHtml(pr.host) + " · " + escHtml(pr.hood) + "</span>" +
          '<span class="tw-pop-open">Open event</span></a>' +
          '<button data-plan="1"></button></div>',
      )
      .addTo(this.map);
    const el = this.popup.getElement();
    const pc = el.querySelector<HTMLElement>(".maplibregl-popup-content");
    if (pc) {
      pc.style.setProperty("background", dc, "important");
      pc.style.setProperty("border-color", "rgba(0,0,0,0.12)");
    }
    const b = el.querySelector<HTMLButtonElement>("[data-plan]");
    if (!b) return;
    const paint = () => {
      b.textContent = btnText();
      b.style.background = inPlan() ? "rgba(255,255,255,0.35)" : "#111111";
      b.style.color = inPlan() ? ink : "#ffffff";
    };
    paint();
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.host.togglePlan(id);
      paint();
    });
  }

  // ---------- floating labels ----------

  private labelEl(f: EventFeature, hover: boolean, stemH = 8) {
    const p = f.properties, dc = dayColor(p.day, "#191919");
    const dark = this.host.isNight() && isMobile();
    const el = document.createElement("div");
    el.className = "tw-label";
    const pill = document.createElement("div");
    pill.className = "tw-label-pill" + (dark ? " is-dark" : "");
    if (hover) pill.style.borderColor = dc;
    const dot = document.createElement("span");
    dot.className = "tw-label-dot";
    dot.style.background = dc;
    const txt = document.createElement("span");
    txt.textContent = labelText(p);
    pill.append(dot, txt);
    const stem = document.createElement("div");
    stem.className = "tw-label-stem";
    stem.style.cssText = "height:" + stemH + "px;background:" + dc;
    el.append(pill, stem);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openPopup(f);
    });
    return el;
  }

  private clearLabels() {
    for (const m of this.labels.values()) m.remove();
    this.labels.clear();
  }

  /**
   * Places up to 28 billboarded labels: the top 3–5 events per neighborhood (plan first, then earliest),
   * only inside the visible map area between the panels, stacking stems upward or nudging sideways to avoid overlap.
   * Labels already on screen keep their slot unless `force` is set.
   */
  private updateLabels(force = false) {
    if (this.disposed) return;
    if (this.host.hideTags()) return this.clearLabels();
    const map = this.map;
    const cv = map.getCanvas();
    if (Math.abs(cv.clientWidth - this.container.clientWidth) > 1) map.resize();
    const z = map.getZoom();
    const planIds = this.host.getPlanIds();
    // On mobile, labels step aside once the user starts planning.
    if (!this.eventsFC.features.length || z < 12 || (isMobile() && planIds.length)) return this.clearLabels();
    const W = cv.clientWidth, H = cv.clientHeight;
    const { left: L, right: Rr, top: T } = this.host.labelBounds(cv.getBoundingClientRect(), W);
    const plan = new Set(planIds);
    // Only label dots that actually rendered (not hidden behind buildings or culled).
    let vis: Set<string> | null = null;
    try {
      vis = new Set(map.queryRenderedFeatures({ layers: ["events-dot"] }).map((f) => String(f.properties.id)));
    } catch {
      vis = null;
    }
    const groups = new Map<string, { f: EventFeature; pt: { x: number; y: number }; s: number }[]>();
    for (const f of this.eventsFC.features) {
      const pt = map.project(f.geometry.coordinates as LngLatLike);
      if (pt.x < L + 10 || pt.y < T + 20 || pt.x > Rr - 10 || pt.y > H - 10) continue;
      const fid = String(f.properties.id);
      if (vis && !vis.has(fid) && fid !== this.selId) continue;
      const g = f.properties.hood || "x";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({
        f,
        pt,
        // plan first, then the opened event, then labels already shown, then nearest the camera (lowest on screen)
        s: (plan.has(+f.properties.id) ? 0 : 100000) + (this.labels.has(fid) ? -50000 : 0) + (fid === this.selId ? -200000 : 0) + (H - pt.y),
      });
    }
    const perArea = z > 15.6 ? 5 : z > 14.9 ? 4 : 3;
    const cands: { f: EventFeature; pt: { x: number; y: number }; s: number; r: number }[] = [];
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.s - b.s);
      arr.slice(0, perArea).forEach((c, r) => cands.push({ ...c, r }));
      for (const c of arr.slice(perArea, perArea + 4)) cands.push({ ...c, r: 50 });
    }
    cands.sort((a, b) => a.r - b.r || a.s - b.s);
    const boxes: { x1: number; x2: number; y1: number; y2: number }[] = [];
    const keep: { f: EventFeature; st: number; dx: number }[] = [];
    const STEMS = [8, 32, 56, 80, 104, 128];
    const hit = (bx: (typeof boxes)[number]) => boxes.some((o) => bx.x1 < o.x2 + 3 && bx.x2 > o.x1 - 3 && bx.y1 < o.y2 + 2 && bx.y2 > o.y1 - 2);
    for (const c of cands) {
      if (keep.length >= 28) break;
      const w = labelText(c.f.properties).length * 5.9 + 26, h = 20;
      let done = false;
      for (const st of STEMS) {
        for (const dx of [0, -w / 2 + 10, w / 2 - 10]) {
          const bx = { x1: c.pt.x - w / 2 + dx, x2: c.pt.x + w / 2 + dx, y2: c.pt.y - 6 - st, y1: c.pt.y - 6 - st - h };
          if (bx.y1 < T || bx.x1 < L || bx.x2 > Rr) continue;
          if (!hit(bx)) {
            boxes.push(bx);
            keep.push({ f: c.f, st, dx });
            done = true;
            break;
          }
        }
        if (done) break;
      }
    }
    const want = new Map(keep.map((k) => [String(k.f.properties.id), k.st + "/" + Math.round(k.dx)]));
    for (const [id, m] of this.labels) {
      if (force || want.get(id) !== m._slot) {
        m.remove();
        this.labels.delete(id);
      }
    }
    for (const k of keep) {
      const id = String(k.f.properties.id);
      if (this.labels.has(id)) continue;
      const el = this.labelEl(k.f, false, k.st);
      if (k.dx) (el.firstChild as HTMLElement).style.transform = "translateX(" + Math.round(k.dx) + "px)";
      const m = new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -6] }).setLngLat(k.f.geometry.coordinates as LngLatLike).addTo(map) as LabelMarker;
      m._slot = k.st + "/" + Math.round(k.dx);
      this.labels.set(id, m);
    }
  }

  private hoverLabel(f: EventFeature | null) {
    if (isMobile() && this.host.getPlanIds().length) f = null;
    const id = f ? String(f.properties.id) : null;
    if (this.hoverMarker && this.hoverId === id) return;
    this.hoverMarker?.remove();
    this.hoverMarker = null;
    this.hoverId = null;
    if (!f || this.labels.has(id!)) return;
    // Use our own feature (layer query results carry tile-rounded coordinates).
    const src = this.eventsFC.features.find((x) => String(x.properties.id) === id) || f;
    this.hoverId = id;
    this.hoverMarker = new maplibregl.Marker({ element: this.labelEl(src, true), anchor: "bottom", offset: [0, -6] })
      .setLngLat(src.geometry.coordinates as LngLatLike)
      .addTo(this.map);
  }
}
