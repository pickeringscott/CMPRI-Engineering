'use strict';
const get = id => document.getElementById(id);
const form = get('reviewForm');
const weather = get('weatherWindow');
const role = get('reviewRole');
const banner = get('reviewBanner');
const publishButton = get('reviewPublish');
const override = get('reviewOverride');
const severity = get('reviewSeverity');
const wall = get('reviewWallpaper');
const widgetRadar = get('reviewWidgetRadar');
let draft = null;
let published = null;
let radarUp = false;
let reopenForChief = false;
const chief = () => role.value === 'chief';
function frame(target, modeName, title) {
  if (target.hidden) { target.replaceChildren(); return; }
  if (target.firstChild) return;
  const element = document.createElement('iframe');
  element.title = title;
  element.src = 'cmpri-radar-review.html?mode=' + modeName;
  element.allowFullscreen = true;
  target.append(element);
}
function render() {
  get('reviewIdentity').textContent = 'Residence Inn Champaign · ' + (chief() ? 'Chief Engineer' : 'CMPRI staff');
  get('reviewHeading').textContent = chief() ? 'Engineering Dashboard' : 'Property Operations';
  get('reviewEditor').hidden = !chief();
  const privatePreview = chief() && draft;
  const shown = privatePreview || published;
  banner.hidden = !shown;
  get('reviewExit').hidden = !privatePreview;
  get('reviewReturn').hidden = !privatePreview;
  if (shown) {
    banner.style.background = shown.color;
    const channels = shown.color.slice(1).match(/../g).map(value => {
      const s = parseInt(value,16)/255;
      return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4;
    });
    banner.style.color = (channels[0]*.2126+channels[1]*.7152+channels[2]*.0722) > .179 ? '#000' : '#fff';
    get('reviewBannerStatus').textContent = privatePreview ? 'Chief Engineer preview' : 'CMPRI weather alert · simulated publication';
    get('reviewBannerText').textContent = shown.message;
  }
  wall.hidden = !shown?.wallpaper;
  frame(wall,'wallpaper','Live radar desktop wallpaper');
  const showWidgetRadar = radarUp && wall.hidden;
  widgetRadar.hidden = !showWidgetRadar;
  frame(widgetRadar,'widget','Compact live radar');
  get('reviewDial').hidden = showWidgetRadar;
  get('reviewFlip').hidden = !wall.hidden || showWidgetRadar;
  publishButton.disabled = !draft;
}
function readDraft() {
  return {message:get('reviewMessage').value.trim(),color:get('reviewColor').value,wallpaper:!override.disabled&&override.checked};
}
function status(message) { get('reviewStatus').textContent = message; }
form.addEventListener('submit', event => {
  event.preventDefault();
  if (!chief()) return;
  const next = readDraft();
  if(!next.message){status('Enter a banner message.');return}
  draft=next;
  reopenForChief=true;
  get('closeWeather').click();
  render();
  get('reviewReturn').focus();
});
publishButton.onclick = () => {
  if (!chief() || !draft) return;
  published=draft;
  draft=null;
  reopenForChief=false;
  render();
  status('Published within the mockup. Switch to CMPRI staff to verify the banner and wallpaper.');
  get('closeWeather').click();
};
get('reviewReturn').onclick = () => get('weatherLauncher').click();
get('reviewExit').onclick = () => { draft=null;render();get('weatherLauncher').click(); };
get('reviewClear').onclick = () => {
  if (!chief()) return;
  draft=null;published=null;render();status('Simulation cleared.');
};
form.addEventListener('input', () => {
  override.disabled=severity.value==='advisory';
  if(override.disabled) override.checked=false;
  if(draft) {draft=null;render();status('Preview the updated banner before publishing.');}
});
role.onchange = () => {if(!weather.hidden)get('closeWeather').click();render()};
get('reviewDial').onclick = () => get('weatherLauncher').click();
get('reviewFlip').onclick = () => {radarUp=true;render()};
window.addEventListener('message', event => {
  if(event.origin!==location.origin || event.source!==widgetRadar.firstChild?.contentWindow || event.data!=='cmpri-weather-review-flip')return;
  radarUp=false;render();get('reviewFlip').focus();
});
const formatter = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function tick() {
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(part=>[part.type,part.value]));
  const angle=(Number(parts.hour)*3600+Number(parts.minute)*60+Number(parts.second))*Math.PI/43200;
  get('reviewTimeDot').setAttribute('cx',String(50+41*Math.sin(angle)));
  get('reviewTimeDot').setAttribute('cy',String(50-41*Math.cos(angle)));
  get('reviewTime').textContent=parts.hour+':'+parts.minute+' CT';
}
async function temperature() {
  try {
    const response=await fetch('/api/weather-preview?part=dashboard',{signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('Weather unavailable');
    const { dashboard: data }=await response.json();
    get('reviewTemp').textContent=Number.isFinite(data?.current)?Math.round(data.current)+'°':'—';
  } catch { get('reviewTemp').textContent='—'; }
}
new MutationObserver(()=>{
  if(!weather.hidden && chief() && draft && reopenForChief) {
    reopenForChief=false;
    status('Preview ready. Publish to show it in the staff view.');
    publishButton.focus();
  }
}).observe(weather,{attributes:true,attributeFilter:['hidden']});
tick();setInterval(tick,1000);
void temperature();setInterval(()=>{if(!document.hidden)void temperature()},300000);
render();
