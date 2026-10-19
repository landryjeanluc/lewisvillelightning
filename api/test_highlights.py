"""Real MP4 upload, authorization, retries and byte-range playback."""
from io import BytesIO
from uuid import uuid4

import av
import httpx
from PIL import Image

from app import signer
from highlights import MEDIA_DIR


def sample_clip():
    buffer = BytesIO()
    with av.open(buffer, 'w', format='mp4') as output:
        output.metadata['title'] = 'private source metadata'
        stream = output.add_stream('libx264', rate=24)
        stream.width = 320
        stream.height = 180
        stream.pix_fmt = 'yuv420p'
        for i in range(48):
            frame = av.VideoFrame.from_image(Image.new('RGB', (320, 180), (i * 5, 40, 90)))
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)
    return buffer.getvalue()


async def run_highlight_tests(app, pool, ok):
    results = []
    def check(name, condition):
        results.append(ok('highlights: ' + name, condition))
    transport = httpx.ASGITransport(app=app)
    clients = []
    for role in ('admin', 'parent', 'player', 'viewer'):
        uid = await pool.fetchval("INSERT INTO users(email,display_name,password_hash,role) VALUES($1,'Highlight test','unused',$2) RETURNING id", 'highlights-' + role, role)
        clients.append(httpx.AsyncClient(transport=transport, base_url='http://t/api', cookies={'lvlnb_session': signer.dumps([uid, 1])}))
    admin, parent, player, viewer = clients
    async with httpx.AsyncClient(transport=transport, base_url='http://t/api') as anon:
        try:
            raw = sample_clip()
            id = str(uuid4())
            body = {'id': id, 'player_id': 'pl-02', 'title': 'A great save', 'game_id': 'g-2026-10-17-kent', 'bytes': len(raw)}
            check('anonymous cannot list', (await anon.get('/highlights?player_id=pl-02')).status_code == 401)
            for client in (parent, player, viewer):
                check('only admin can begin an upload', (await client.post('/highlights/uploads', json=body)).status_code == 403)
            check('unknown player rejected', (await admin.post('/highlights/uploads', json=dict(body, player_id='unknown'))).status_code == 404)
            check('unknown game rejected', (await admin.post('/highlights/uploads', json=dict(body, game_id='unknown'))).status_code == 422)
            check('oversized video rejected before upload', (await admin.post('/highlights/uploads', json=dict(body, bytes=104857601))).status_code == 422)
            check('blank title rejected', (await admin.post('/highlights/uploads', json=dict(body, title='   '))).status_code == 422)
            r = await admin.post('/highlights/uploads', json=body)
            check('admin starts upload', r.status_code == 201 and r.json()['received'] == 0)
            check('upload metadata cannot be silently replaced', (await admin.post('/highlights/uploads', json=dict(body, title='Another clip'))).status_code == 409)
            check('unfinished clips stay off profiles', (await parent.get('/highlights?player_id=pl-02')).json()['highlights'] == [])
            check('unfinished video inaccessible', (await parent.get(f'/highlights/{id}/video')).status_code == 404)
            check('cannot publish partial upload', (await admin.post(f'/highlights/uploads/{id}/publish')).status_code == 409)
            check('parent cannot send chunks', (await parent.put(f'/highlights/uploads/{id}?offset=0', content=raw)).status_code == 403)
            split = len(raw) // 2
            r = await admin.put(f'/highlights/uploads/{id}?offset=0', content=raw[:split])
            check('first chunk stored', r.status_code == 200 and r.json()['received'] == split)
            check('duplicate chunk safely acknowledged', (await admin.put(f'/highlights/uploads/{id}?offset=0', content=raw[:split])).status_code == 200)
            check('different bytes cannot overwrite a chunk', (await admin.put(f'/highlights/uploads/{id}?offset=0', content=b'x' * split)).status_code == 409)
            r = await admin.post('/highlights/uploads', json=body)
            check('retry resumes at saved position', r.json()['received'] == split)
            check('out-of-order chunk rejected', (await admin.put(f'/highlights/uploads/{id}?offset={split+1}', content=raw[split:])).status_code == 409)
            await admin.put(f'/highlights/uploads/{id}?offset={split}', content=raw[split:])
            check('player cannot publish', (await player.post(f'/highlights/uploads/{id}/publish')).status_code == 403)
            r = await admin.post(f'/highlights/uploads/{id}/publish')
            check('valid MP4 published', r.status_code == 200 and r.json()['duration'] == 2)
            check('publish retry does not duplicate', (await admin.post(f'/highlights/uploads/{id}/publish')).status_code == 200 and await pool.fetchval("SELECT count(*) FROM audit_log WHERE action='highlight_publish'") == 1)
            for client in (parent, player, viewer):
                r = await client.get('/highlights?player_id=pl-02')
                check('team can view player highlights', r.status_code == 200 and len(r.json()['highlights']) == 1 and not r.json()['can_manage'])
            check('clip belongs to the selected player', (await viewer.get('/highlights?player_id=pl-03')).json()['highlights'] == [])
            check('source upload removed after publish', not (MEDIA_DIR / id / 'source.mp4').exists())
            with av.open(str(MEDIA_DIR / id / 'video.mp4')) as saved:
                check('private source metadata stripped', 'title' not in saved.metadata)
            for kind in ('video', 'poster'):
                check('anonymous media denied', (await anon.get(f'/highlights/{id}/{kind}')).status_code == 401)
                r = await parent.get(f'/highlights/{id}/{kind}')
                check('media authenticated and not cached', r.status_code == 200 and r.headers['cache-control'] == 'no-store')
            r = await parent.get(f'/highlights/{id}/video', headers={'Range': 'bytes=0-15'})
            check('video seeking supports byte ranges', r.status_code == 206 and len(r.content) == 16 and r.headers['content-range'].startswith('bytes 0-15/'))
            r = await parent.head(f'/highlights/{id}/video')
            check('video HEAD returns metadata only', r.status_code == 200 and not r.content)
            check('family cannot remove highlights', (await parent.delete(f'/highlights/{id}')).status_code == 403)
            check('admin can remove highlight', (await admin.delete(f'/highlights/{id}')).status_code == 200)
            check('removed clip no longer accessible', (await parent.get(f'/highlights/{id}/video')).status_code == 404 and not (MEDIA_DIR / id / 'video.mp4').exists())
            bad_id = str(uuid4())
            bad = dict(body, id=bad_id, bytes=12)
            await admin.post('/highlights/uploads', json=bad)
            await admin.put(f'/highlights/uploads/{bad_id}?offset=0', content=b'not an mp4!!')
            r = await admin.post(f'/highlights/uploads/{bad_id}/publish')
            check('invalid media cannot publish', r.status_code == 422)
            await admin.delete(f'/highlights/{bad_id}')
        finally:
            for client in clients:
                await client.aclose()
    return results
