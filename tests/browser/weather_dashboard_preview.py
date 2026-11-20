"""Fixture acceptance for the real Engineering dashboard's Weather preview.

Start a local build with VERCEL_ENV=preview and synthetic public auth settings,
then run: python tests/browser/weather_dashboard_preview.py --base http://127.0.0.1:3116

Every browser API request is intercepted. Accounts and application responses use
cmpri_fixture; NWS/map responses below are explicit local test fixtures. External
requests are blocked. This verifies UI integration and lifecycle, not live-feed
availability, real accounts, persistence, pushes, or Supabase behavior.
"""

import argparse
import asyncio
import json
import math
import os
import re
import struct
import sys
import time
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from zoneinfo import ZoneInfo

sys.dont_write_bytecode = True
os.environ.setdefault("CMPRI_UI_OUTPUT", "/tmp/cmpri-weather-dashboard-review")
from cmpri_fixture import install
from playwright.async_api import async_playwright


PREVIEW = "/previews/cmpri-weather-preview.html"
RADAR = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer"
WSSI = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer"
API = "https://api.weather.gov"
POINT = "40.138080,-88.251416"
HOUR = timedelta(hours=1)
PROBE = r"""(() => {
  window.__weatherReviewForbidden = [];
  const forbid = (owner, name) => {
    try { if (owner && typeof owner[name] === 'function') owner[name] = () => {
      window.__weatherReviewForbidden.push(name);
      return name === 'requestPermission' ? Promise.resolve('denied') : undefined;
    }; } catch (_) {}
  };
  forbid(window.Notification, 'requestPermission');
  forbid(navigator.geolocation, 'getCurrentPosition');
  forbid(navigator.geolocation, 'watchPosition');
  if (window.PushManager) forbid(PushManager.prototype, 'subscribe');
  if (window === window.top) {
    window.__weatherOriginalAudioContext = window.AudioContext || window.webkitAudioContext;
    const audit=window.__weatherAudioAudit={created:0,resumes:0,decodes:0,starts:[],stops:[],gains:[],holdDecode:false,blockResume:false,pendingDecodes:[]};
    const buffer=()=>({duration:11.72,numberOfChannels:1,sampleRate:48000,length:562560,getChannelData:()=>new Float32Array(562560)});
    audit.releaseDecodes=()=>{audit.holdDecode=false;for(const resolve of audit.pendingDecodes.splice(0))resolve(buffer());};
    class QuietAudioContext {
      constructor(){audit.created++;this.state='suspended';this.destination={};this.sampleRate=48000;this.listeners=[];}
      get currentTime(){return Date.now()/1000;}
      resume(){audit.resumes++;if(audit.blockResume)return Promise.reject(new Error('TEST FIXTURE playback blocked'));this.state='running';this.listeners.forEach(fn=>fn());return Promise.resolve();}
      suspend(){this.state='suspended';return Promise.resolve();}
      close(){this.state='closed';return Promise.resolve();}
      addEventListener(name,fn){if(name==='statechange')this.listeners.push(fn);}
      removeEventListener(name,fn){this.listeners=this.listeners.filter(value=>value!==fn);}
      decodeAudioData(){audit.decodes++;return audit.holdDecode?new Promise(resolve=>audit.pendingDecodes.push(resolve)):Promise.resolve(buffer());}
      createBufferSource(){const id=audit.starts.length+audit.stops.length+1;return {buffer:null,onended:null,connect(target){return target;},disconnect(){},start(when){audit.starts.push({id,when});},stop(when){audit.stops.push({id,when});}};}
      createGain(){const parameter={value:1};for(const method of ['setValueAtTime','linearRampToValueAtTime','exponentialRampToValueAtTime','setTargetAtTime','cancelScheduledValues'])parameter[method]=(...args)=>{audit.gains.push({method,args});return parameter;};return {gain:parameter,connect(target){return target;},disconnect(){}};}
    }
    window.AudioContext=QuietAudioContext;window.webkitAudioContext=QuietAudioContext;
  }
  if (window === window.top || !location.pathname.includes('/previews/cmpri-weather-preview.html')) return;
  const audit = {closed: false, intervalIds: [], aborts: 0, map: null, nws: null,
    forbidden: window.__weatherReviewForbidden};
  window.__weatherFrameAudit = audit;
  window.__weatherAuditWrapped = true;
  try { (parent.__weatherFrameAudits ||= []).push(audit); } catch (_) {}
  const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
  window.setInterval = (handler, delay, ...args) => {
    const id = set(handler, delay, ...args); audit.intervalIds.push(id); return id;
  };
  window.clearInterval = id => { audit.intervalIds = audit.intervalIds.filter(value => value !== id); return clear(id); };
  const abort = AbortController.prototype.abort;
  AbortController.prototype.abort = function (...args) { audit.aborts++; return abort.apply(this, args); };
  window.addEventListener('pagehide', () => queueMicrotask(() => {
    audit.closed = true;
    audit.map = window.cmpriWeatherMap?.getState?.() || null;
    audit.nws = window.nwsLiveView?.getState?.() || null;
  }));
})();"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def iso(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def png_fixture(width=16, height=16, rgba=(30, 170, 75, 180)):
    """A local raster fixture, not generated weather or a remote image."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + bytes(rgba) * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


async def wait_for(page_or_frame, expression, arg=None, timeout=15000):
    # DevTools evaluation avoids CSP-blocked eval() in Playwright wait functions.
    deadline = time.monotonic() + timeout / 1000
    while True:
        if await page_or_frame.evaluate(expression, arg):
            return
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out: " + expression)
        await asyncio.sleep(.05)


async def block_websocket(socket):
    # HTTP routes do not intercept WebSockets. Do not connect dashboard Realtime
    # to any external service, including the synthetic Supabase hostname.
    await socket.close(code=1000, reason="Local fixture blocks external connections")


async def install_weather_audit(frame):
    # Iframe init scripts may first execute for about:blank. Attach explicitly
    # once the actual Weather document exists instead of depending on that race.
    await frame.evaluate("""() => {
      if (window.__weatherFrameAudit) return;
      const audit = window.__weatherFrameAudit = {closed:false,intervalIds:[],aborts:0,map:null,nws:null,
        forbidden:window.__weatherReviewForbidden || []};
      (parent.__weatherFrameAudits ||= []).push(audit);
      if (!window.__weatherAuditWrapped) {
        window.__weatherAuditWrapped=true;
        const set=window.setInterval.bind(window), clear=window.clearInterval.bind(window);
        window.setInterval=(handler,delay,...args) => {const id=set(handler,delay,...args);audit.intervalIds.push(id);return id;};
        window.clearInterval=id => {audit.intervalIds=audit.intervalIds.filter(value=>value!==id);return clear(id);};
        const abort=AbortController.prototype.abort;
        AbortController.prototype.abort=function(...args){audit.aborts++;return abort.apply(this,args);};
      }
    }""")


class OfficialFeedFixtures:
    """Deterministic official-response shapes; no service is contacted."""
    def __init__(self):
        self.now = datetime.now(timezone.utc).replace(microsecond=0)
        self.forecast_calls = 0
        self.observation_calls = 0
        self.history_calls = 0
        self.alert_calls = 0
        self.astronomy_calls = 0
        self.hold_astronomy = False
        self.astronomy_gate = asyncio.Event()
        self.astronomy_gate.set()
        self.astronomy_pending = asyncio.Event()
        self.willard_calls=0
        self.willard_modes={'arrivals':'live','departures':'live'}
        self.willard_empty=set()
        self.hold_willard=False
        self.willard_gate=asyncio.Event();self.willard_gate.set()
        self.willard_pending=asyncio.Event()
        self.map_urls = []
        self.exports = []
        self.image_exports = []
        self.radar_export_delay = 0
        self.radar_held_times = set()
        self.radar_held_gate = asyncio.Event()
        self.radar_held_gate.set()
        self.basemap_requests = []
        self.reference_requests = []
        self._basemap_active = set()
        self.basemap_inflight = 0
        self.basemap_max_inflight = 0
        self.basemap_fail_datasets = set()
        self.hold_basemap = False
        self.basemap_gate = asyncio.Event()
        self.basemap_pending = asyncio.Event()
        self.wms_requests = []
        self.wms_modes = {name:'fresh' for name in ['reflectivity','velocity','precipitation','satellite','lightning']}
        self.wms_now = None
        self.wms_colors = {'reflectivity':(30,170,75,180),'velocity':(180,65,205,150),
            'precipitation':(85,205,225,170),'satellite':(40,85,130,200),'lightning':(250,215,35,210)}
        self.wms_legend_images = {}
        self.wms_held_products = set()
        self.wms_product_gates = {name:asyncio.Event() for name in self.wms_modes}
        self.wms_product_pending = {name:asyncio.Event() for name in self.wms_modes}
        for gate in self.wms_product_gates.values(): gate.set()
        self.wms_metadata = {}
        self.wms_legend_delay = 0
        self.hold_wms = False
        self.wms_gate = asyncio.Event()
        self.wms_pending = asyncio.Event()
        self.hold_forecast = True
        self.hold_observation = True
        self.hold_alerts = True
        self.hold_history = True
        self.hold_map = False
        self.forecast_gate = asyncio.Event()
        self.observation_gate = asyncio.Event()
        self.alert_gate = asyncio.Event()
        self.history_gate = asyncio.Event()
        self.map_gate = asyncio.Event()
        self.forecast_pending = asyncio.Event()
        self.observation_pending = asyncio.Event()
        self.alert_pending = asyncio.Event()
        self.history_pending = asyncio.Event()
        self.map_pending = asyncio.Event()
        self.scan_times = [int((self.now - timedelta(minutes=10)).timestamp() * 1000),
                           int((self.now - timedelta(minutes=5)).timestamp() * 1000)]

    def envelope(self, source, data, station=None):
        result = {"status": "live", "source": source, "receivedAt": iso(self.now),
                  "sourceTimestamp": iso(self.now - timedelta(minutes=15)),
                  "data": data, "error": None}
        if station:
            result["station"] = station
        return result

    def nws(self):
        issued = iso(self.now - timedelta(minutes=15))
        point = {"type": "Feature", "properties": {
            "forecast": API + "/gridpoints/ILX/95,74/forecast",
            "forecastHourly": API + "/gridpoints/ILX/95,74/forecast/hourly",
            "forecastGridData": API + "/gridpoints/ILX/95,74",
            "observationStations": API + "/gridpoints/ILX/95,74/stations"}}
        station = {"id": "KCMI", "name": "TEST FIXTURE Champaign station", "latitude": 40.04,
                   "longitude": -88.28, "distanceMeters": 11265}
        observation = {"type": "Feature", "properties": {
            "timestamp": iso(self.now - timedelta(minutes=6)), "station": API + "/stations/KCMI",
            "textDescription": "TEST FIXTURE observed conditions",
            "temperature": {"value": 17.7777778, "unitCode": "wmoUnit:degC"},
            "windSpeed": {"value": 16.09344, "unitCode": "wmoUnit:km_h-1"},
            "windDirection": {"value": 225, "unitCode": "wmoUnit:degree_(angle)"},
            "windGust": {"value": None, "unitCode": "wmoUnit:km_h-1"},
            "visibility": {"value": None, "unitCode": "wmoUnit:m"},
            "windChill": {"value": None, "unitCode": "wmoUnit:degC"},
            "heatIndex": {"value": None, "unitCode": "wmoUnit:degC"}}}
        day_start = self.now.astimezone(ZoneInfo("America/Chicago")).replace(hour=0, minute=0, second=0, microsecond=0)
        history = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": API + "/stations/KCMI/observations/TEST-FIXTURE-" + str(index),
             "properties": {"timestamp": iso(stamp), "temperature": {"value": value, "unitCode": "wmoUnit:degF"}}}
            for index, (stamp, value) in enumerate([(self.now - timedelta(minutes=30), 60),
                                                    (self.now - timedelta(minutes=6), 64)])
            if stamp >= day_start - timedelta(minutes=90)]}
        def forecast(hourly):
            return {"type": "Feature", "properties": {"updated": issued, "updateTime": issued,
                "generatedAt": issued, "periods": [{"number": n + 1,
                    "name": "TEST FIXTURE " + ("hourly" if hourly else "extended") + " " + str(n + 1),
                    "startTime": iso(self.now + n * (HOUR if hourly else 12 * HOUR)),
                    "endTime": iso(self.now + (n + 1) * (HOUR if hourly else 12 * HOUR)),
                    "isDaytime": True, "temperature": 67 + n, "temperatureUnit": "F",
                    "probabilityOfPrecipitation": {"value": 73, "unitCode": "wmoUnit:percent"},
                    "windSpeed": "12 mph", "windDirection": "SW",
                    "shortForecast": "TEST FIXTURE hourly rain signal" if hourly else "TEST FIXTURE extended forecast",
                    "detailedForecast": "Explicit local forecast fixture; no live conditions are claimed."}
                    for n in range(12 if hourly else 7)]}}
        interval = iso(self.now + HOUR) + "/PT1H"
        grid = {"type": "Feature", "properties": {"updateTime": issued,
            "snowfallAmount": {"uom": "wmoUnit:mm", "values": [{"validTime": interval, "value": 25.4}]},
            "iceAccumulation": {"uom": "wmoUnit:mm", "values": [{"validTime": interval, "value": None}]}}}
        bulletin = API + "/alerts/urn:oid:TEST-FIXTURE-POLYGONLESS"
        alerts = {"type": "FeatureCollection", "features": [{"type": "Feature", "id": bulletin,
            "geometry": None, "properties": {"@id": bulletin, "id": "TEST-FIXTURE-POLYGONLESS",
                "status": "Actual", "messageType": "Alert", "event": "Winter Weather Advisory",
                "headline": "TEST FIXTURE applicable polygonless county advisory", "areaDesc": "Champaign County",
                "effective": iso(self.now - timedelta(minutes=5)), "expires": iso(self.now + 2 * HOUR),
                "description": "Explicit local test fixture. No NWS alert has been issued by this test.",
                "instruction": "Fixture instructions."}}]}
        return {"location": {"name": "Residence Inn Champaign", "latitude": 40.138080,
                "longitude": -88.251416, "timeZone": "America/Chicago"}, "checkedAt": iso(self.now),
            "history": {"dayStart": iso(day_start), "queryStart": iso(day_start - timedelta(minutes=90)),
                "asOf": iso(self.now), "timeZone": "America/Chicago", "anchorLookbackMinutes": 90,
                "queryComplete": True, "truncated": False, "returnedCount": len(history["features"])},
            "resources": {
                "points": self.envelope(API + "/points/" + POINT, point),
                "forecast": self.envelope(API + "/gridpoints/ILX/95,74/forecast", forecast(False)),
                "hourly": self.envelope(API + "/gridpoints/ILX/95,74/forecast/hourly", forecast(True)),
                "grid": self.envelope(API + "/gridpoints/ILX/95,74", grid),
                "stations": self.envelope(API + "/gridpoints/ILX/95,74/stations", {"type": "FeatureCollection", "features": []}),
                "observation": self.envelope(API + "/stations/KCMI/observations/latest", observation, station),
                "history": self.envelope(API + "/stations/KCMI/observations?start=" + iso(day_start - timedelta(minutes=90))
                    + "&end=" + iso(self.now) + "&limit=500", history, station),
                "alerts": self.envelope(API + "/alerts/active?point=" + POINT, alerts)}}

    def astronomy(self):
        return {'location':{'name':'Residence Inn Champaign','latitude':40.138080,'longitude':-88.251416,'timeZone':'America/Chicago'},
            'checkedAt':iso(self.now),'resources':{'astronomy':{'status':'live','source':'https://github.com/cosinekitty/astronomy',
                'sourceTimestamp':iso(self.now),'data':{'moonPhase':{'label':'First Quarter','angle':90,'illumination':.5,
                    'calculatedAt':iso(self.now),'sourceUrl':'https://github.com/cosinekitty/astronomy'},'events':[],
                    'aurora':{'status':'unavailable','error':'TEST FIXTURE aurora data unavailable','observationTime':None,'forecastTime':None}},
                'error':None}}}

    def willard(self):
        day=self.now.astimezone(ZoneInfo('America/Chicago')).date().isoformat()
        rows={'arrivals':[
            ('AA1234','American Airlines','Chicago','ORD','16:05','Scheduled'),
            ('BA5678','British Airways','Chicago','ORD','16:05','Scheduled'),
            ('AA1313','American Airlines','Dallas-Fort Worth','DFW','17:45','Delayed')],
            'departures':[
            ('AA4321','American Airlines','Chicago','ORD','18:20','Boarding'),
            ('AA4444','American Airlines','Dallas-Fort Worth','DFW','05:53','Cancelled')]}
        boards={}
        for kind in ['arrivals','departures']:
            live=self.willard_modes[kind]=='live'
            flights=[] if not live or kind in self.willard_empty else [
                {'id':'TEST-FIXTURE-'+kind+'-'+str(index),'flight':flight,'airline':airline,'location':location,
                 'iata':iata,'date':day,'time':time,'status':status}
                for index,(flight,airline,location,iata,time,status) in enumerate(rows[kind])]
            boards[kind]={'status':'live' if live else 'unavailable','sourceUrl':'https://www.avionio.com/en/airport/cmi/'+kind,
                'retrievedAt':iso(self.now) if live else None,'providerDate':day if live else None,'flights':flights,
                'error':None if live else 'TEST FIXTURE '+kind+' unavailable','explicitEmpty':live and kind in self.willard_empty}
            if kind=='departures' and len(flights)>1:
                flights[1]['date']=(self.now.astimezone(ZoneInfo('America/Chicago')).date()+timedelta(days=1)).isoformat()
        return {'airport':'KCMI','iata':'CMI','timeZone':'America/Chicago','checkedAt':iso(self.now),'boards':boards}

    def wms(self, product):
        name, style, path = {
            "reflectivity": ("conus_bref_qcd", "radar_reflectivity", "conus/conus_bref_qcd/ows"),
            "velocity": ("kilx_sr_bvel", "radar_velocity", "kilx/ows"),
            "precipitation": ("conus_pcpn_typ", "radar_precip_type", "conus/conus_pcpn_typ/ows"),
            'satellite':('goes_longwave_imagery','goes-lir','observations/satellite/ows'),
            'lightning':('ldn_lightning_strike_density','lightning_density','observations/lightning_detection/ows'),
        }[product]
        source = ('https://nowcoast.noaa.gov/geoserver/' if product in ['satellite','lightning'] else 'https://opengeo.ncep.noaa.gov/geoserver/') + path
        age = 180 if self.wms_modes[product] == 'stale' else {'satellite':9,'lightning':2,'precipitation':6}.get(product,4)
        now = self.wms_now or self.now
        times = ([iso(datetime.fromtimestamp(value / 1000, timezone.utc)) for value in self.scan_times]
                 if product == "reflectivity" else [iso(now - timedelta(minutes=age + minutes)) for minutes in [12, 6, 0]])
        return {"product": product, "source": source + "?service=WMS&version=1.3.0&request=GetCapabilities",
            "checkedAt": iso(self.now), "version": "1.3.0", "mapFormats": ["image/png"],
            "legendSupported": True, "xml": "<!-- explicit local WMS test fixture -->",
            "layers": [{"name": name, "title": "TEST FIXTURE official " + product,
                "crs": ["EPSG:3857", "EPSG:4326", "EPSG:4269", "CRS:84"],
                "time": {"units": "ISO8601", "default": times[-1], "current": False, "values": ",".join(times)},
                "styles": [{"name": style, "title": "TEST FIXTURE advertised style",
                    "legendUrl": source + "?service=WMS&request=GetLegendGraphic&layer=" + name}]}]}

    async def route(self, route):
        parsed = urlparse(route.request.url)
        require(route.request.method == "GET", "Weather endpoints must remain read-only")
        if parsed.path=='/api/willard-flights':
            self.willard_calls+=1;self.willard_pending.set()
            if self.hold_willard: await self.willard_gate.wait()
            try: await route.fulfill(content_type='application/json',body=json.dumps(self.willard()))
            except Exception:
                if not route.request.failure: raise
            return
        if parsed.path == "/api/weather-preview/wms":
            params = parse_qs(parsed.query)
            product, operation = [params.get(key, [""])[0] for key in ["product", "op"]]
            require(product in self.wms_modes and operation in ["capabilities", "map", "legend"],
                    "WMS fixture received an unsupported product or operation")
            self.wms_requests.append({"product": product, "op": operation, "params": params})
            if self.wms_modes[product] == "unavailable":
                await route.fulfill(status=502, content_type="application/json",
                    body=json.dumps({"unavailable": True, "error": {"code": 502, "message": "TEST FIXTURE official WMS unavailable"}}))
                return
            if operation == "capabilities":
                metadata = self.wms(product)
                self.wms_metadata[product] = metadata
                if product == "reflectivity":
                    self.map_urls.append(metadata["source"])
                await route.fulfill(content_type="application/json", body=json.dumps(metadata))
                return
            metadata = self.wms_metadata.get(product)
            require(metadata is not None, "WMS image requested before advertised metadata was read")
            layer = metadata["layers"][0]
            require(params.get("layer") == [layer["name"]] and params.get("style") == [layer["styles"][0]["name"]],
                    "WMS image did not use an actually advertised layer and style")
            if operation == "map":
                provided_time = datetime.fromisoformat(params.get("time", [""])[0].replace("Z", "+00:00"))
                advertised_times = [datetime.fromisoformat(value.replace("Z", "+00:00"))
                                    for value in layer["time"]["values"].split(",")]
                require(provided_time in advertised_times,
                        "WMS map time was not advertised by its capabilities")
                width, height = [int(params[key][0]) for key in ["width", "height"]]
                bbox = list(map(float, params["bbox"][0].split(",")))
                require(1 <= width <= 1500 and 1 <= height <= 1500 and len(bbox) == 4,
                        "WMS map dimensions or extent exceeded the bounded fixture contract")
                if product == "reflectivity":
                    export = {"time": int(provided_time.timestamp() * 1000), "layer": layer["name"], "style": layer["styles"][0]["name"]}
                    self.exports.append(export)
                    if self.radar_export_delay:
                        await asyncio.sleep(self.radar_export_delay)
                    if self.hold_map:
                        self.map_pending.set()
                        await self.map_gate.wait()
                    if export["time"] in self.radar_held_times and not self.radar_held_gate.is_set():
                        self.map_pending.set()
                        await self.radar_held_gate.wait()
                elif self.hold_wms:
                    self.wms_pending.set()
                    await self.wms_gate.wait()
                if product in self.wms_held_products:
                    self.wms_product_pending[product].set()
                    await self.wms_product_gates[product].wait()
            else:
                width,height={'reflectivity':(500,30),'satellite':(46,62),'lightning':(292,46)}.get(product,(180,24))
                if self.wms_legend_delay:
                    await asyncio.sleep(self.wms_legend_delay)
            color = self.wms_colors[product]
            source_parameters = {
                "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap" if operation == "map" else "GetLegendGraphic",
                "LAYERS" if operation == "map" else "LAYER": layer["name"],
                "STYLES" if operation == "map" else "STYLE": layer["styles"][0]["name"], "FORMAT": "image/png"}
            if operation == "map":
                source_parameters.update({"CRS": "EPSG:3857", "BBOX": params["bbox"][0],
                    "WIDTH": str(width), "HEIGHT": str(height), "TIME": params["time"][0]})
            source = metadata["source"].split("?")[0] + "?" + urlencode(source_parameters)
            if product == "reflectivity":
                self.map_urls.append(source)
                if operation == "map":
                    self.image_exports.append(export)
            body=self.wms_legend_images.get(product) if operation=='legend' else None
            try:
                await route.fulfill(content_type="image/png", body=body or png_fixture(width, height, color), headers={
                    "X-Weather-Source": source, "X-Weather-Layer": layer["name"],
                    "X-Weather-Time": params.get("time", ["source-default"])[0]})
            except Exception:
                if not route.request.failure: raise
            return
        if parsed.path == "/api/weather-preview/basemap":
            params = parse_qs(parsed.query)
            dataset = params.get("dataset", [""])[0]
            if params.get("op") == ["route-features"]:
                require(dataset == "roads", "Unknown official route source")
                z = int(params.get("z", ["-1"])[0])
                require(0 <= z <= 16, "Route labels used unsupported ground zoom")
                bbox = list(map(float, params.get("bbox", [""])[0].split(",")))
                self.reference_requests.append({"op": "route-features", "dataset": "routes", "bbox": bbox, "z": z})
                if self.hold_basemap:
                    self.basemap_pending.set()
                    await self.basemap_gate.wait()
                records = []
                for index, (route_type, number) in enumerate([("INTERSTATE", "74"), ("INTERSTATE", "74"),
                        ("INTERSTATE", "57"), ("INTERSTATE", "57"), ("US_ROUTE", "150"), ("ST_ROUTE", "10"), ("INTERSTATE", "72")]):
                    fx,fy = [(.80,.55),(.22,.58),(.43,.28),(.43,.68),(.78,.72),(.5,.17),(.22,.72)][index]
                    x=bbox[0]+(bbox[2]-bbox[0])*fx; y=bbox[1]+(bbox[3]-bbox[1])*fy
                    def coordinate(px,py):
                        return [math.degrees(px/6378137),math.degrees(2*math.atan(math.exp(py/6378137))-math.pi/2)]
                    start=coordinate(x-1000,y-500); end=coordinate(x+1000,y+500)
                    fields = {"OBJECTID": index+1, "permanent_identifier": "TEST-ROUTE-"+str(index), route_type: number, "STFIPS":"17", "STATE":"IL"}
                    if z >= 10:
                        fields = {("state_route" if key == "ST_ROUTE" else key.lower()): value for key,value in fields.items()}
                    records.append({"type":"Feature","properties":fields,"geometry":{"type":"LineString",
                        "coordinates":[start,end]}})
                await route.fulfill(content_type="application/json",body=json.dumps({
                    "source":"https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/9/query",
                    "receivedAt":iso(self.now),"data":{"type":"FeatureCollection","features":records},"error":None}))
                return
            if params.get("op") == ["place-labels"]:
                require(dataset == "places", "Unknown incorporated-place source")
                bbox = list(map(float, params.get("bbox", [""])[0].split(",")))
                require(len(bbox) == 4 and bbox[0] < bbox[2] and bbox[1] < bbox[3], "GNIS query extent is invalid")
                self.reference_requests.append({"op": "place-labels", "dataset": "places", "bbox": bbox})
                if self.hold_basemap:
                    self.basemap_pending.set()
                    await self.basemap_gate.wait()
                records = [
                    {"type": "Feature", "properties": {"gaz_name": "City of Champaign", "gaz_id": 1, "OBJECTID": 1},
                     "geometry": {"type": "Point", "coordinates": [-88.244, 40.116]}},
                    {"type": "Feature", "properties": {"gaz_name": "Champaign", "gaz_id": 2, "OBJECTID": 2},
                     "geometry": {"type": "MultiPoint", "coordinates": [[-88.248, 40.121]]}},
                    {"type": "Feature", "properties": {"gaz_name": "City of Urbana", "gaz_id": 3, "OBJECTID": 3},
                     "geometry": {"type": "Point", "coordinates": [-88.207, 40.112]}},
                ]
                def inside(feature):
                    geometry = feature["geometry"]
                    points = [geometry["coordinates"]] if geometry["type"] == "Point" else geometry["coordinates"]
                    for lon, lat in points:
                        x = 6378137 * math.radians(lon)
                        y = 6378137 * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
                        if bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3]:
                            return True
                    return False
                await route.fulfill(content_type="application/json", body=json.dumps({
                    "source": "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/1/query",
                    "receivedAt": iso(self.now), "data": {"type": "FeatureCollection", "features": [row for row in records if inside(row)]}, "error": None}))
                return
            if params.get("op") == ["reference"]:
                require(dataset in ["roads", "places"], "Unknown official ground reference")
                width, height = [int(params[name][0]) for name in ["width", "height"]]
                require(1 <= width <= 1500 and 1 <= height <= 1500, "Ground reference image is unbounded")
                bbox = list(map(float, params.get("bbox", [""])[0].split(",")))
                require(len(bbox) == 4 and bbox[0] < bbox[2] and bbox[1] < bbox[3], "Ground reference extent is invalid")
                self.reference_requests.append({"dataset": dataset, "width": width, "height": height, "bbox": bbox})
                if self.hold_basemap:
                    self.basemap_pending.set()
                    await self.basemap_gate.wait()
                # Transparent reference-image fixture. Its sparse marks prove
                # composition without replacing the aerial background pixels.
                def chunk(kind, data):
                    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
                rows = []
                for y in range(height):
                    line = bytearray()
                    for x in range(width):
                        road = dataset == "roads" and abs(x - round(width * .4)) <= 2
                        place = dataset == "places" and abs(y - round(height * .2)) <= 2 and width * .7 <= x <= width * .82
                        line.extend((248, 248, 248, 220) if road else (240, 230, 180, 230) if place else (0, 0, 0, 0))
                    rows.append(b"\x00" + bytes(line))
                image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b"")
                source = "https://carto.nationalmap.gov/arcgis/rest/services/" + ("transportation" if dataset == "roads" else "geonames") + "/MapServer/export"
                await route.fulfill(content_type="image/png", body=image, headers={"X-USGS-Source": source, "X-Weather-Source": source})
                return
            require(dataset in ["topo", "imagery", "relief"], "Unknown ground-map source")
            z, x, y = [int(params[name][0]) for name in ["z", "x", "y"]]
            require(0 <= z <= 16 and 0 <= x < 2 ** z and 0 <= y < 2 ** z,
                    "Ground map requested tiles outside the verified native zoom range")
            self.basemap_requests.append({"dataset": dataset, "z": z, "x": x, "y": y})
            self._basemap_active.add(route.request)
            self.basemap_inflight = len(self._basemap_active)
            self.basemap_max_inflight = max(self.basemap_max_inflight, self.basemap_inflight)
            try:
                if self.hold_basemap:
                    self.basemap_pending.set()
                    await self.basemap_gate.wait()
                # A brief deterministic network delay exposes unbounded queues.
                await asyncio.sleep(.025)
                if dataset in self.basemap_fail_datasets:
                    await route.fulfill(status=503, content_type="application/json",
                                        body=json.dumps({"error": "TEST FIXTURE ground tiles unavailable"}))
                else:
                    color = {"topo": (52, 101, 173, 255), "imagery": (173, 80, 42, 255),
                             "relief": (112, 140, 64, 255)}[dataset]
                    await route.fulfill(content_type="image/png", body=png_fixture(256, 256, color))
            finally:
                self._basemap_active.discard(route.request)
                self.basemap_inflight = len(self._basemap_active)
            return
        if parsed.path == '/api/weather-preview/astronomy':
            self.astronomy_calls += 1
            self.astronomy_pending.set()
            if self.hold_astronomy:
                await self.astronomy_gate.wait()
            try:
                await route.fulfill(content_type='application/json',body=json.dumps(self.astronomy()))
            except Exception:
                pass  # Removing/closing the document can abort this held read.
            return
        if parsed.path == "/api/weather-preview":
            part = parse_qs(parsed.query).get("part", [None])[0]
            require(part in [None, "observation", "history", "alerts", "forecast"], "Unknown partial NWS fixture request")
            if part == "observation":
                self.observation_calls += 1
                self.observation_pending.set()
                if self.hold_observation:
                    await self.observation_gate.wait()
            elif part == "alerts":
                self.alert_calls += 1
                self.alert_pending.set()
                if self.hold_alerts:
                    await self.alert_gate.wait()
            elif part == "history":
                self.history_calls += 1
                self.history_pending.set()
                if self.hold_history:
                    await self.history_gate.wait()
            else:
                self.forecast_calls += 1
                self.forecast_pending.set()
                if self.hold_forecast:
                    await self.forecast_gate.wait()
            try:
                data = self.nws()
                if part:
                    keys = {"observation": ["observation"], "history": ["history"], "alerts": ["alerts"], "forecast": ["points", "forecast", "hourly", "grid"]}[part]
                    data["resources"] = {key: value for key, value in data["resources"].items() if key in keys}
                await route.fulfill(content_type="application/json", body=json.dumps(data))
            except Exception:
                if not (self.forecast_gate.is_set() and self.observation_gate.is_set() and self.alert_gate.is_set() and self.history_gate.is_set()):
                    raise
            return
        require(parsed.path == "/api/weather-preview/map", "Unexpected Weather endpoint: " + parsed.path)
        target = parse_qs(parsed.query).get("url", [""])[0]
        source = urlparse(target)
        require(source.scheme == "https" and source.hostname == "mapservices.weather.noaa.gov", "Map proxy accepted an unofficial source")
        self.map_urls.append(target)
        query = parse_qs(source.query)
        if target.startswith(RADAR):
            if source.path.endswith("/query"):
                data = {"objectIdFieldName": "objectid", "features": [
                    {"attributes": {"objectid": 99001 + n, "idp_validtime": stamp}}
                    for n, stamp in enumerate(self.scan_times)]}
            elif source.path.endswith("/exportImage"):
                rule = json.loads(query.get("mosaicRule", ["{}"])[0])
                self.exports.append(rule)
                require(rule.get("lockRasterIds") in [[99001 + n] for n in range(len(self.scan_times))],
                        "Export did not lock to an exact catalog fixture raster")
                if self.radar_export_delay:
                    await asyncio.sleep(self.radar_export_delay)
                if self.hold_map:
                    self.map_pending.set()
                    await self.map_gate.wait()
                if query.get("f") == ["image"]:
                    self.image_exports.append(rule)
                    width, height = map(int, query["size"][0].split(","))
                    await route.fulfill(content_type="image/png", body=png_fixture(width, height))
                    return
                bbox = list(map(float, query["bbox"][0].split(",")))
                width, height = map(int, query["size"][0].split(","))
                data = {"href": "https://mapservices.weather.noaa.gov/TEST-FIXTURE-RADAR.png",
                        "width": width, "height": height,
                        "extent": dict(zip(["xmin", "ymin", "xmax", "ymax"], bbox))}
            else:
                data = {"objectIdField": "objectid", "timeInfo": {"startTimeField": "idp_validtime"},
                        "fields": [{"name": "objectid"}, {"name": "idp_validtime"}]}
        elif source.path.endswith("TEST-FIXTURE-RADAR.png"):
            await route.fulfill(content_type="image/png", body=png_fixture())
            return
        elif target.startswith(WSSI):
            data = {"features": []} if source.path.endswith("/query") else {
                "fields": [{"name": name} for name in ["impact", "issue_time", "start_time", "end_time", "idp_filedate"]],
                "drawingInfo": {"renderer": {"uniqueValueInfos": []}}}
        else:
            raise AssertionError("Unexpected official map fixture request: " + target)
        try:
            await route.fulfill(content_type="application/json", body=json.dumps(data))
        except Exception:
            if not self.map_gate.is_set():
                raise

    def request_failed(self, request):
        # Canceled browser fetches no longer count as concurrent traffic even
        # if their intercepted route is still unwinding a fixture delay.
        self._basemap_active.discard(request)
        self.basemap_inflight = len(self._basemap_active)

    def release(self):
        self.hold_willard=False;self.willard_gate.set()
        self.hold_astronomy = False
        self.astronomy_gate.set()
        self.hold_forecast = False
        self.hold_observation = False
        self.hold_alerts = False
        self.hold_history = False
        self.hold_map = False
        self.forecast_gate.set()
        self.observation_gate.set()
        self.alert_gate.set()
        self.history_gate.set()
        self.map_gate.set()
        self.radar_held_gate.set()
        self.hold_basemap = False
        self.basemap_gate.set()
        self.hold_wms = False
        self.wms_gate.set()
        self.wms_held_products.clear()
        for gate in self.wms_product_gates.values(): gate.set()


async def weather_frame(page):
    locator = page.locator('iframe[src*="' + PREVIEW + '"]')
    await locator.wait_for(state="visible", timeout=30000)
    require(await locator.count() == 1, "Expected one Weather iframe")
    element = await locator.element_handle()
    frame = await element.content_frame()
    await wait_for(frame, "Boolean(window.weatherPreview && window.nwsLiveView && window.cmpriWeatherMap)", timeout=30000)
    return frame


async def airport_checks(page, frame, requests, output, width, feed):
    airport=frame.locator('#willardAirport')
    initial=await frame.evaluate('weatherPreview.getState().airport')
    require(not initial['expanded'] and not initial['iframeMounted'] and not initial['clockRunning']
            and initial['flightRequests']==0 and not requests, 'Collapsed Willard performs network or clock work')
    await airport.locator(':scope > summary').click()
    await wait_for(frame, "weatherPreview.getState().airport.trackerStatus==='document-loaded'")
    await wait_for(frame,"weatherPreview.getState().airport.boardStatus==='live' && !weatherPreview.getState().airport.flightPending")
    require(len(requests)==1 and requests[0]['method']=='GET','Expanding Willard did not make exactly one provider document read')
    require(feed.willard_calls==1,'Expanding Willard did not make exactly one shared native-board read')
    provider=airport.locator('[data-willard-tracker] > iframe')
    attrs=await provider.evaluate("el=>Object.fromEntries(['src','width','height','title','loading','referrerpolicy'].map(key=>[key,el.getAttribute(key)]))")
    require(attrs=={'src':'https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9&compact=1','width':'100%','height':'450',
        'title':'Live flight tracker map by AvioADSB','loading':'lazy','referrerpolicy':'strict-origin-when-cross-origin'},
        'Provider embed template was changed: '+str(attrs))
    board=airport.locator('[data-willard-board]')
    require(await board.get_attribute('data-style')=='london' and await board.get_attribute('data-time-format')=='24h',
            'Fixed London board or Chief Central clock is incorrect')
    require(await airport.locator('select,input').count()==0,'Willard exposes unrequested selectors or search')
    arrivals=await airport.locator('[data-willard-arrivals] tr[data-flight] .wa-flight-number').all_inner_texts()
    departures=await airport.locator('[data-willard-departures] tr[data-flight] .wa-flight-number').all_inner_texts()
    require(arrivals==['AA1234','BA5678','AA1313'] and departures==['AA4321','AA4444'],
            'Native boards dropped published flights/codeshares or inserted fictional rows: '+str([arrivals,departures]))
    require(await airport.locator('[data-willard-arrivals] .wa-flight-time').first.inner_text()=='16:05',
            'Chief native board did not preserve the published Central wall time')
    require(not re.search(r'SAMPLE|DEMO|API key|no.key|token',await airport.inner_text(),re.I),
            'Airport product UI includes sample data or implementation/key instructions')
    status=await frame.evaluate('weatherPreview.getState().airport')
    require(status['arrivals']['status']=='live' and status['departures']['status']=='live' and status['aircraftCoverageVerified'] is False
            and status['backgroundPolling'] is False and status['flightRequests']==1 and status['clockRunning'],
            'Willard native board state or tracker-coverage claim is wrong')
    await page.clock.fast_forward(120010)
    require(len(requests)==1 and feed.willard_calls==1,'Airport clock performs repeated provider or flight polling')
    await board.evaluate("el=>el.scrollIntoView({block:'start'})")
    await page.screenshot(path=str(output/f'weather-willard-open-{width}.png'),full_page=True)
    await provider.evaluate("el=>el.scrollIntoView({block:'start'})")
    await page.screenshot(path=str(output/f'weather-willard-tracker-{width}.png'),full_page=True)
    await airport.locator(':scope > summary').click()
    await wait_for(frame, '!weatherPreview.getState().airport.iframeMounted && !weatherPreview.getState().airport.clockRunning')
    require(await airport.locator('iframe').count()==0 and len(requests)==1,'Collapsed airport retained provider browsing context or reloaded it')
    await airport.locator(':scope > summary').click()
    await wait_for(frame,"weatherPreview.getState().airport.trackerStatus==='document-loaded'")
    await wait_for(frame,"weatherPreview.getState().airport.flightRequests===2 && !weatherPreview.getState().airport.flightPending")
    require(feed.willard_calls==2,'Re-expanding an expired native-board cache did not perform one read')
    await frame.evaluate("() => {Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));}")
    await wait_for(frame,'!weatherPreview.getState().airport.iframeMounted && !weatherPreview.getState().airport.clockRunning')
    inactive=await frame.evaluate('weatherPreview.getState().airport')
    require(inactive['iframeUnloads']==2 and len(requests)==2,'Hidden airport failed to unload its provider')
    await frame.evaluate("() => {Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));}")
    await wait_for(frame,"weatherPreview.getState().airport.trackerStatus==='document-loaded'")
    await airport.locator(':scope > summary').click()
    await wait_for(frame,'!weatherPreview.getState().airport.iframeMounted')
    require(len(requests)==3,'Restoring an expanded airport did not create exactly one fresh provider context')
    require(feed.willard_calls==2,'Returning to visible reloaded the fresh native-board cache')
    return {'collapsedNoProviderRequests':True,'expandOnlyDocumentAndNativeBoardReads':True,'nativeLondonRowsFromPayload':True,
        'codesharesRetained':True,'noInventedRowsOrSelectors':True,'providerTemplateIntact':True,'collapseAndHiddenUnload':True,
        'noFlightPolling':True,'providerRequestsIntercepted':requests,'actualAircraftCoverageVerified':False}


async def run_viewport(browser, base, output, width, height):
    context = await browser.new_context(viewport={"width": width, "height": height},
        has_touch=width < 640, is_mobile=width < 640, service_workers="block", reduced_motion="reduce")
    await context.route_web_socket("**/*", block_websocket)
    feed = OfficialFeedFixtures()
    context.on("requestfailed", feed.request_failed)
    counts, posts, external, mutations, errors = {}, [], [], [], []
    airport_requests = []
    await install(context, "chief_engineer", counts=counts, posts=posts)
    await context.route("**/api/weather-preview**", feed.route)
    await context.route('**/api/willard-flights**',feed.route)

    async def protect(route):
        request = route.request
        parsed = urlparse(request.url)
        if request.url == 'https://avioadsb.org/embed/map?lat=40.03&lon=-88.28&zoom=9&compact=1':
            airport_requests.append({'url':request.url,'method':request.method})
            await route.fulfill(status=200,content_type='text/html',body='<!doctype html><html><body><p>Provider iframe lifecycle test fixture. Aircraft coverage is not verified.</p></body></html>')
            return
        if parsed.hostname not in ["127.0.0.1", "localhost"]:
            external.append({"url": request.url, "method": request.method})
            await route.abort("blockedbyclient")
            return
        if parsed.path.startswith("/api/") and request.method not in ["GET", "HEAD"]:
            mutations.append({"path": parsed.path, "method": request.method})
        # Existing fixture route fulfills every application API; no API reaches
        # the running server, and no browser request can reach a database host.
        await route.fallback()

    await context.route("**/*", protect)
    await context.add_init_script(PROBE)
    page = await context.new_page()
    await page.clock.install(time=feed.now)
    page.on("pageerror", lambda error: errors.append(str(error)))
    evidence = {"viewport": [width, height], "fixtureOnly": True}
    try:
        await page.goto(base + "/engineering", wait_until="domcontentloaded")
        launcher = page.get_by_role("button", name="Weather", exact=True)
        await launcher.wait_for(state="visible", timeout=60000)
        require(feed.forecast_calls == 0 and feed.astronomy_calls == 0 and not feed.map_urls and not feed.basemap_requests,
                "Weather or ground-map feeds requested before opening Weather")
        operations = page.locator("fieldset").filter(has=page.locator("legend", has_text="Operations"))
        require(await operations.get_by_role("button", name="Weather", exact=True).count() == 1, "Weather launcher is outside existing Operations")
        before_mutations = len(mutations)
        await launcher.click()
        frame = await weather_frame(page)
        require(not airport_requests and feed.willard_calls==0 and await frame.locator('#willardAirport iframe').count()==0,
                'Willard provider requested before the airport accordion opened')
        require(await frame.locator('#tab-weather,#tab-notifications,#tab-checks').count()==0,
                'Removed Weather tabs remain in the single-view layout')
        await install_weather_audit(frame)
        # Native close dispatches this event before React unmounts the iframe.
        # Observe after the content's registered close handler; removed iframes
        # need not deliver pagehide in every Chromium configuration.
        await frame.evaluate("""() => {
          const audit = parent.__weatherFrameAudits.at(-1);
          parent.__weatherDashboardClosingAudit = audit;
          const capture = () => {
            audit.closed = true;
            audit.map = window.cmpriWeatherMap.getState();
            audit.nws = window.nwsLiveView.getState();
          };
          document.addEventListener('cmpri-modal-cancel-request', capture);
          const original = window.nwsLiveView.close;
          window.nwsLiveView.close = (...args) => { const result = original(...args); capture(); return result; };
        }""")
        native = page.locator('[data-cmpri-desktop-window="' + PREVIEW + '"]')
        require(await native.count() == 1, "Weather did not use one native DesktopWindow")
        require(parse_qs(urlparse(frame.url).query).get("embedded") == ["1"], "Weather iframe did not use embedded=1")
        for selector in [".appbar", ".navbar", "#dashboard", ".titlebar"]:
            for item in await frame.locator(selector).all():
                require(not await item.is_visible(), "Duplicate standalone chrome in native window: " + selector)
        require(await native.locator(".cmpri-desktop-titlebar").count() == 1, "Native window must own the only titlebar")
        await wait_for(frame, "window.nwsLiveView.getState().loading")
        require(not await frame.locator("#liveTemperature .wv-temperature-marker").count(), "A fabricated temperature marker appeared while the observation was held")
        require(await frame.locator("#hourlyForecast .forecast-card").count() == 0, "Sample forecasts appeared while loading")
        require("Jan 15" not in await frame.locator("#panel-weather").inner_text(), "Old weather examples remain in live view")
        evidence["loadingHasNoSampleValues"] = True
        feed.release()
        await wait_for(frame, "document.querySelector('#liveTemperature .wv-temperature-value')?.textContent === '64°'")
        require("TEST FIXTURE observed conditions" in await frame.locator("#liveConditionText").inner_text(), "Observation response was not rendered")
        station_source = await frame.locator("#liveObservationTime").inner_text()
        require("KCMI" in station_source, "Current observation does not identify Willard KCMI")
        require(await frame.locator('#liveGusts').count()==0,'Missing observed gust became a visible value')
        require((await frame.locator('#liveFeelsLike').inner_text()).strip()=='Feels Like —',
                'Missing observed Feels Like became zero or a fabricated value')
        for element in ["liveVisibility", "liveIce"]:
            value = await frame.locator("#" + element).inner_text()
            require("unavailable" in value.lower() or value.startswith("—"), "Missing " + element + " became a value")
        require("10" in await frame.locator("#liveWind").inner_text() and "MPH" in await frame.locator("#liveWind").inner_text(), "Observation wind conversion failed")
        require("Residence Inn Champaign" in await frame.locator('.view-head').inner_text()
                and "502 West Marketview Drive" in await frame.locator('.location').inner_text(),
                "Removing the orange feed box also removed the hotel identity")
        for removed in [".offline-note", "#tab-sources", "#panel-sources", ".guest-safety-priority"]:
            require(await frame.locator(removed).count() == 0, "Removed feed/source/Guest Safety review section remains: "+removed)
        require(await frame.locator("#hourlyForecast .forecast-card").count() == 12, "Hourly response periods missing")
        days = set()
        for resource_name in ["hourly", "forecast"]:
            for period in feed.nws()["resources"][resource_name]["data"]["properties"]["periods"]:
                day = datetime.fromisoformat(period["startTime"].replace("Z", "+00:00")).astimezone(ZoneInfo("America/Chicago")).date()
                end_day = (datetime.fromisoformat(period["endTime"].replace("Z", "+00:00")) - timedelta(microseconds=1)).astimezone(ZoneInfo("America/Chicago")).date()
                while day <= end_day:
                    days.add(day.isoformat())
                    day += timedelta(days=1)
        daily_cards = await frame.locator("#extendedForecast .daily-forecast-card").evaluate_all("els=>els.map(el=>el.dataset.day)")
        require(daily_cards == sorted(days), "Daily forecast cards do not cover the actual supplied Central calendar days")
        require(await frame.locator("#extendedForecast .wv-temperature-dial").count() == len(days),
                "A daily forecast is missing its 24-hour dial")
        require("73%" in await frame.locator("#hourlyForecast .forecast-chance").first.inner_text(),
                "Hourly precipitation chance missing")
        require("TEST FIXTURE extended forecast" in await frame.locator("#extendedForecast").inner_text(), "Extended response not rendered")
        for removed in ["refreshNws", "liveFeedStatus", "nwsHourlySource", "nwsExtendedSource", "nwsAccumulationSource"]:
            require(await frame.locator("#" + removed).count() == 0,
                    "Removed footer refresh/provenance control remains: " + removed)
        require("Official NWS resources" not in await frame.locator("#panel-weather").inner_text(),
                "Removed Official NWS resources footer remains")
        alerts = frame.locator("#liveAlertsHost")
        require("no polygon supplied" in await alerts.inner_text(), "Applicable polygonless alert was dropped")
        require("TEST FIXTURE applicable polygonless county advisory" in await alerts.inner_text(), "Official alert response missing")
        require(await alerts.get_by_role("link", name="Read official bulletin").count() == 1, "Official bulletin link missing")
        require(await page.locator("[data-weather-guest-safety-dialog][data-fullscreen='true']").count() == 0,
                "A regular advisory unexpectedly opened a fullscreen warning")
        evidence["nwsResponseRendering"] = {"temperature": "64°", "hourly": 12, "daily": len(days),
            "missingRemainsUnavailable": True, "polygonlessAlertRetained": True, "removedFooterAndManualRefresh": True}
        await wait_for(frame, "window.cmpriWeatherMap.getState().status.radar === 'Observed image loaded'")
        state = await frame.evaluate("window.cmpriWeatherMap.getState()")
        require(state["mode"] == "live" and state["frameCount"] == 2, "Map used fabricated/default frames")
        require(state["scanTimes"] == feed.scan_times, "Observed scan times differ from exact catalog fixtures")
        require(bool(feed.exports) and feed.exports[0]["time"] == feed.scan_times[-1],
                "Latest radar PNG did not use an exact advertised scan time")
        reflectivity = state["reflectivity"]
        require(reflectivity["layer"] == "conus_bref_qcd" and reflectivity["style"] == "radar_reflectivity",
                "Reflectivity raster and legend do not use the verified NOAA layer/style")
        require(bool(feed.image_exports), "Map did not decode the advertised NOAA WMS PNG")
        evidence["mapResponseRendering"] = {"scanTimes": state["scanTimes"], "latestAdvertisedTime": feed.scan_times[-1],
            "layer": reflectivity["layer"], "style": reflectivity["style"],
            "fixtureBitmapLoaded": True, "officialShapedWmsPngDecoded": True}
        await page.screenshot(path=str(output / f"weather-dashboard-{width}.png"), full_page=True)
        sizes = await frame.evaluate("({width:innerWidth,document:document.documentElement.scrollWidth,body:document.getElementById('windowBody').clientWidth,content:document.getElementById('windowBody').scrollWidth})")
        require(sizes["document"] <= sizes["width"] + 1 and sizes["content"] <= sizes["body"] + 1, "Embedded Weather horizontal overflow: " + str(sizes))
        if width < 640:
            box = await native.bounding_box()
            desktop = await page.locator(".cmpri-desktop").bounding_box()
            require(abs(box["width"] - (desktop["width"] - 8)) < 2, "Mobile Weather did not match the native 4px desktop insets")
        evidence['willardAirport'] = await airport_checks(page, frame, airport_requests, output, width, feed)
        # Hidden simulation engines remain a regression seam, not visible UI.
        await frame.evaluate("() => {const el=document.getElementById('npScenario');el.value='tornado-warning';el.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('npReceive').click();}")
        safety = page.locator("[data-weather-guest-safety-dialog]")
        await safety.wait_for(state="visible")
        instruction = await safety.locator("[data-weather-hotel-instruction]").inner_text()
        require("immediately" in instruction and "first-floor interior hallways" in instruction,
                "Native Guest Safety is missing the tornado shelter instruction")
        await safety.locator("[data-weather-guest-safety-close]").click()
        await frame.evaluate("document.getElementById('npRepeat').click()")
        require(await page.locator("[data-weather-guest-safety-dialog]").is_hidden(), "Unchanged sample reopened Guest Safety")
        await frame.locator("#playLoop").click()
        await wait_for(frame, "window.cmpriWeatherMap.getState().playing")
        # Hold two real foreground fetches (fulfilled locally) while unmounting:
        # closing must stop playback and abort both map and forecast requests.
        feed.hold_forecast = True
        feed.forecast_gate.clear()
        feed.forecast_pending.clear()
        feed.hold_map = True
        feed.map_gate.clear()
        feed.map_pending.clear()
        await frame.evaluate("() => { void nwsLiveView.refresh(); }")
        await asyncio.wait_for(feed.forecast_pending.wait(), timeout=5)
        await frame.locator("#zoomOut").click()
        await asyncio.wait_for(feed.map_pending.wait(), timeout=5)
        await wait_for(frame, "window.cmpriWeatherMap.getState().pendingRequests > 0 && window.nwsLiveView.getState().pendingRequests > 0")
        await frame.locator('#willardAirport > summary').click()
        await wait_for(frame,"weatherPreview.getState().airport.trackerStatus==='document-loaded'")
        calls_before_close = feed.forecast_calls
        nws_before_close = [feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls]
        astronomy_before_close = feed.astronomy_calls
        await frame.evaluate("window.__weatherRetainedMemory = 'same-page-instance'")
        await native.get_by_role("button", name="Close Weather", exact=True).click()
        await page.locator('iframe[src*="' + PREVIEW + '"]').wait_for(state="hidden")
        require(await native.is_hidden(), "Native Weather window remained visible after its X")
        airport_closed=await frame.evaluate('weatherPreview.getState().airport')
        require(not airport_closed['iframeMounted'] and not airport_closed['clockRunning']
                and await frame.locator('#willardAirport iframe').count()==0,
                'Native close retained the airport browsing context or display clock')
        require(await page.locator('iframe[src*="' + PREVIEW + '"]').count() == 1,
                "Closing Weather discarded its cached iframe")
        feed.release()
        await wait_for(page, "window.__weatherDashboardClosingAudit?.closed === true")
        closed = await page.evaluate("window.__weatherDashboardClosingAudit")
        require(closed["intervalIds"] == [] and not closed["map"]["playing"], "Playback survived native window close")
        require(closed["map"]["pendingRequests"] == 0 and closed["nws"]["pendingRequests"] == 0, "Requests survived native window close")
        require(closed["aborts"] >= 2, "Pending map and NWS fetches were not aborted")
        await asyncio.sleep(.25)
        require(feed.forecast_calls == calls_before_close, "A check ran after Weather closed")
        await launcher.click()
        reopened = await weather_frame(page)
        await wait_for(reopened, "document.querySelector('#liveTemperature .wv-temperature-value')?.textContent === '64°'")
        require([feed.observation_calls, feed.history_calls, feed.forecast_calls, feed.alert_calls] == nws_before_close,
                "Instant reopening reloaded NWS data instead of showing the cached view")
        require(feed.astronomy_calls == astronomy_before_close, 'Instant reopening reloaded cached astronomy')
        require(await reopened.evaluate("window.__weatherRetainedMemory") == "same-page-instance",
                "Instant reopening created a new Weather document")
        require(await native.count() == 1, "Reopening created duplicate native windows")
        evidence["nativeCloseAndReopen"] = {"playbackStopped": True, "pendingFetchesAborted": True,
            "iframeRetainedInMemory": True, "noNwsReloadOnInstantReopen": True}
        require(not await frame_forbidden(page), "Weather requested GPS, notification permission, or push registration")
        require(len(mutations) == before_mutations, "Opening Weather caused an application mutation: " + str(mutations[before_mutations:]))
        require(not errors, "JavaScript errors: " + str(errors))
        evidence.update({"passed": True, "externalRequestsBlocked": external, "applicationApiRequestsIntercepted": counts,
            "weatherRequests": feed.forecast_calls, "mapRequests": len(feed.map_urls), "noApplicationMutation": True,
            "noRealDatabaseOrPush": True, "errors": errors})
        print(f"PASS actual dashboard Weather integration {width}×{height} (local feed fixtures)", flush=True)
        return evidence
    finally:
        feed.release()
        await context.close()


async def frame_forbidden(page):
    found = await page.evaluate("(window.__weatherFrameAudits || []).flatMap(audit => audit.forbidden || [])")
    for frame in page.frames:
        try:
            found.extend(await frame.evaluate("window.__weatherReviewForbidden || []"))
        except Exception:
            pass
    return found


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("CMPRI_UI_BASE", "http://127.0.0.1:3116"))
    parser.add_argument("--output", default=os.environ["CMPRI_UI_OUTPUT"])
    args = parser.parse_args()
    require(urlparse(args.base).hostname in ["127.0.0.1", "localhost"], "Only a local fixture server is permitted")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True,
            executable_path=os.environ.get("CHROMIUM_EXECUTABLE", "/usr/bin/chromium"), args=["--no-sandbox"])
        try:
            for width, height in [(1440, 1000), (390, 844)]:
                try:
                    results.append(await run_viewport(browser, args.base.rstrip("/"), output, width, height))
                except Exception as error:
                    results.append({"viewport": [width, height], "passed": False, "error": str(error), "fixtureOnly": True})
                    print(f"FAIL {width}×{height}: {error}", flush=True)
        finally:
            await browser.close()
    report = {"fixtureOnly": True, "liveFeedAvailabilityVerified": False, "results": results}
    (output / "weather-dashboard-report.json").write_text(json.dumps(report, indent=2))
    require(all(row["passed"] for row in results), "Dashboard Weather fixture acceptance failed; see " + str(output / "weather-dashboard-report.json"))


if __name__ == "__main__":
    asyncio.run(main())
