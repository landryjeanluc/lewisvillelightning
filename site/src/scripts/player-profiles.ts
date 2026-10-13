import { api } from './api-client';
import { md } from './live';
void (async () => {
  const response = await api('/profiles');
  if (!response.ok) return;
  const profiles = response.body;
  const positions:Record<string,string>={C:'Centre',LW:'Left Wing',RW:'Right Wing',F:'Forward',D:'Defence',G:'Goaltender'};
  for(const detail of document.querySelectorAll<HTMLElement>('[data-player-detail]')) {
    const p=profiles[detail.dataset.playerDetail!]; if(!p) continue;
    if(p.position) detail.querySelectorAll('[data-position]').forEach(el => el.textContent=p.position);
    const nickname=detail.querySelector<HTMLElement>('[data-nickname]')!;
    nickname.textContent=p.nickname ?? ''; nickname.hidden=!p.nickname;
    detail.querySelector<HTMLElement>('[data-shoots-row]')!.hidden=!p.shoots;
    detail.querySelector('[data-shoots]')!.textContent=p.shoots==='L'?'Left':'Right';
  }
  for (const card of document.querySelectorAll<HTMLElement>('[data-player-card]')) {
    const profile = profiles[card.dataset.playerCard!];
    if(profile) {
      const position=profile.position || card.dataset.basePosition || '';
      const shoots=profile.shoots;
      card.querySelector('.pc-pos')!.textContent=position;
      card.querySelector('.pc-role')!.textContent=(positions[position] ?? position)+(shoots ? ` · Shoots ${shoots}`:'');
      card.classList.toggle('pcard--goalie',position==='G');
    }
    if (!profile?.card_art || card.dataset.allowPhoto !== 'true') continue;
    // The API validates local image paths; also reject unexpected stored values.
    const path = profile.card_art as string;
    if (!/^\/(uploads|photos)\/[^\\?#]+\.(jpg|jpeg|png|webp)$/i.test(path) || path.includes('/../')) continue;
    const image = document.createElement('img');
    image.className = 'pc-photo'; image.src = path; image.alt = 'Player card';
    image.addEventListener('load', () => {
      card.querySelectorAll('picture, .pc-photo, .pc-number, .pc-watermark').forEach(node => node.remove());
      card.classList.add('pcard--art'); card.querySelector('.pc-art')!.append(image);
    }, {once:true});
  }
  for (const section of document.querySelectorAll<HTMLElement>('[data-profile-detail]')) {
    const profile = profiles[section.dataset.profileDetail!];
    if (!profile?.bio) continue;
    section.querySelector('div')!.innerHTML = md(profile.bio);
    section.hidden = false;
  }
})();
