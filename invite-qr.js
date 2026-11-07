(function () {
    'use strict';

    function boardInvite(room, server, mode) {
        let url = new URL(location.href);
        if (url.protocol === 'file:') {
            url = new URL(server);
            url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
            url.pathname = '/index.html';
        }
        url.search = '';
        url.hash = '';
        url.searchParams.set('room', room);
        url.searchParams.set('syncServer', server);
        url.searchParams.set(mode === 'collaborate' ? 'collaborate' : 'deviceSync', '1');
        return url.href;
    }

    function imageFor(value) {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use a web invitation link to connect another device.');
        if (typeof qrcode !== 'function') throw new Error('Could not load the QR code. Reload Daily and try again.');
        const code = qrcode(0, 'M');
        code.addData(url.href, 'Byte');
        code.make();
        const modules = code.getModuleCount();
        const scale = Math.max(4, Math.ceil(320 / (modules + 8)));
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = (modules + 8) * scale;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This browser could not create the QR image.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#000000';
        for (let row = 0; row < modules; row++) {
            for (let column = 0; column < modules; column++) {
                if (code.isDark(row, column)) context.fillRect((column + 4) * scale, (row + 4) * scale, scale, scale);
            }
        }
        return canvas;
    }

    function widget(root, getValue) {
        root.classList.add('invite-qr');
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn';
        toggle.textContent = 'Show QR';
        const card = document.createElement('div');
        card.className = 'invite-qr-card';
        card.hidden = true;
        const status = document.createElement('p');
        status.className = 'invite-qr-error';
        status.setAttribute('role', 'alert');
        status.hidden = true;
        root.append(toggle, card, status);
        let current = '';

        function fail(error) {
            console.error('Invitation QR failed:', error);
            status.textContent = error.message || 'Could not show the QR code. Try again.';
            status.hidden = false;
        }

        toggle.onclick = () => {
            if (!card.hidden) {
                card.hidden = true;
                toggle.textContent = 'Show QR';
                return;
            }
            try {
                const value = getValue();
                if (!value) throw new Error('Create or join a room first, then show its QR code.');
                const canvas = imageFor(value);
                const image = document.createElement('img');
                image.src = canvas.toDataURL('image/png');
                image.alt = 'Scan this invitation with your other device';
                image.width = image.height = canvas.width;
                const instructions = document.createElement('p');
                instructions.textContent = 'Open the camera on your other device, point it at this code, then open the link.';
                const privacy = document.createElement('p');
                privacy.textContent = 'Share this code privately. Anyone with it can join.';
                const actions = document.createElement('div');
                actions.className = 'invite-qr-actions';
                const save = document.createElement('a');
                save.href = image.src;
                save.download = 'daily-invitation.png';
                save.className = 'btn';
                save.textContent = 'Save QR image';
                actions.append(save);
                if (navigator.share) {
                    const share = document.createElement('button');
                    share.type = 'button';
                    share.className = 'btn';
                    share.textContent = 'Share QR';
                    share.onclick = async () => {
                        share.disabled = true;
                        try {
                            const blob = await new Promise((resolve, reject) => canvas.toBlob(result =>
                                result ? resolve(result) : reject(new Error('Could not prepare the QR image.')), 'image/png'));
                            const file = new File([blob], 'daily-invitation.png', { type: 'image/png' });
                            if (!navigator.canShare?.({ files: [file] })) throw new Error('Sharing images is not available here. Use Save QR image instead.');
                            await navigator.share({ files: [file], title: 'Daily invitation' });
                        } catch (error) {
                            if (error.name !== 'AbortError') fail(error);
                        } finally { share.disabled = false; }
                    };
                    actions.append(share);
                }
                card.replaceChildren(image, instructions, actions, privacy);
                const url = new URL(value);
                if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                    const warning = document.createElement('p');
                    warning.textContent = 'This local link works only on this computer. To connect a phone, open Daily using your deployed website on both devices.';
                    warning.className = 'invite-qr-warning';
                    card.append(warning);
                }
                current = value;
                card.hidden = false;
                status.hidden = true;
                toggle.textContent = 'Hide QR';
            } catch (error) { fail(error); }
        };

        return {
            update() {
                if (current !== getValue()) {
                    card.hidden = true;
                    card.replaceChildren();
                    toggle.textContent = 'Show QR';
                    status.hidden = true;
                    current = '';
                }
            },
            destroy() { root.replaceChildren(); }
        };
    }

    function InviteQr({ value }) {
        const { createElement: h, useRef, useEffect } = React;
        const root = useRef(null), current = useRef(value), control = useRef(null);
        current.current = value;
        useEffect(() => {
            control.current = widget(root.current, () => current.current);
            return () => control.current.destroy();
        }, []);
        useEffect(() => { control.current?.update(); }, [value]);
        return h('div', { ref: root });
    }

    window.DailyInviteQr = { boardInvite, widget, Component: InviteQr };
})();
