const DEFAULT_SERVERS = [
    'http://192.168.5.150:8095',
    'http://nas.tigerest.top:8095'
];

async function tryConnect(server) {
    try {
        if (!server.startsWith("http")) {
            server = "http://" + server;
        }

        console.log("Checking connectivity to:", server);

        const resolvedUrl = await window.jmpCheckServerConnectivity(server);
        console.log("Server connectivity check passed");
        console.log("Resolved URL:", resolvedUrl);

        // Save the human-readable server URL, but navigate to the resolved web client.
        window.jmpInfo.settings.main.userWebClient = server;

        // Navigation will clean up handlers, but do it explicitly
        window.location = resolvedUrl;

        return true;
    } catch (e) {
        console.error("Server connectivity check failed:", e);
        return false;
    }
}

let isConnecting = false;

const updateButtonState = () => {
    const address = document.getElementById('address');
    const button = document.getElementById('connect-button');
    const hasValue = address.value.trim().length > 0;

    if (!isConnecting) {
        button.disabled = !hasValue;
    }
};

const cancelOnEscape = (e) => {
    if (isConnecting && e.key === 'Escape') {
        cancelConnection();
    }
};

const startConnecting = async () => {
    const address = document.getElementById('address');
    const title = document.getElementById('title');
    const spinner = document.getElementById('spinner');
    const button = document.getElementById('connect-button');
    const server = address.value;

    isConnecting = true;
    title.textContent = '';
    title.style.visibility = 'hidden';
    address.classList.add('connecting');
    address.style.visibility = 'hidden';
    address.disabled = true;
    spinner.style.display = 'block';
    button.style.visibility = 'hidden';
    document.addEventListener('keydown', cancelOnEscape);

    // C++ handles retries, just wait for result
    const connected = await tryConnect(server);

    if (!connected) {
        isConnecting = false;
        title.textContent = document.getElementById('title').getAttribute('data-original-text');
        title.style.visibility = 'visible';
        address.classList.remove('connecting');
        address.style.visibility = 'visible';
        address.disabled = false;
        spinner.style.display = 'none';
        button.style.visibility = 'visible';
        document.removeEventListener('keydown', cancelOnEscape);
        updateButtonState();
    }
};

const cancelConnection = () => {
    if (!isConnecting) return;

    console.log("Cancelling connection");
    isConnecting = false;

    // Cancel C++ connectivity check and abort JS promise
    if (window.api && window.api.system) {
        window.api.system.cancelServerConnectivity();
    }
    if (window.jmpCheckServerConnectivity.abort) {
        window.jmpCheckServerConnectivity.abort();
    }

    const address = document.getElementById('address');
    const title = document.getElementById('title');
    const spinner = document.getElementById('spinner');
    const button = document.getElementById('connect-button');

    title.textContent = document.getElementById('title').getAttribute('data-original-text');
    title.style.visibility = 'visible';
    address.classList.remove('connecting');
    address.style.visibility = 'visible';
    address.disabled = false;
    spinner.style.display = 'none';
    button.style.visibility = 'visible';
    document.removeEventListener('keydown', cancelOnEscape);
    updateButtonState();
};

// Button click handler
document.getElementById('connect-button').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!e.target.disabled) {
        startConnecting();
    }
});

// Form submit handler
document.getElementById('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isConnecting) {
        startConnecting();
    }
});

// Input change handler
document.getElementById('address').addEventListener('input', updateButtonState);

document.getElementById('offline-button').addEventListener('click', () => {
    window.tigerestOpenOfflineLibrary();
});


// Enter key handler
document.addEventListener('keydown', (e) => {
    const address = document.getElementById('address');
    if (e.key === 'Enter' && !isConnecting && !address.disabled && address.value.trim()) {
        e.preventDefault();
        startConnecting();
    }
});

function showManualConnection(savedServer) {
    const title = document.getElementById('title');
    const address = document.getElementById('address');
    const spinner = document.getElementById('spinner');
    const button = document.getElementById('connect-button');

    isConnecting = false;
    title.textContent = document.getElementById('title').getAttribute('data-original-text');
    title.style.visibility = 'visible';
    address.classList.remove('connecting');
    address.style.visibility = 'visible';
    address.disabled = false;
    address.value = savedServer || DEFAULT_SERVERS[0];
    spinner.style.display = 'none';
    button.style.visibility = 'visible';
    document.removeEventListener('keydown', cancelOnEscape);
    address.focus();
    updateButtonState();
}

async function autoConnect(servers) {
    const uniqueServers = [...new Set(servers.filter(Boolean))];
    const title = document.getElementById('title');
    const address = document.getElementById('address');
    const spinner = document.getElementById('spinner');
    const button = document.getElementById('connect-button');

    isConnecting = true;
    title.style.visibility = 'visible';
    address.classList.add('connecting');
    address.style.visibility = 'hidden';
    address.disabled = true;
    spinner.style.display = 'block';
    button.style.visibility = 'hidden';
    document.addEventListener('keydown', cancelOnEscape);

    for (const server of uniqueServers) {
        if (!isConnecting) return false;
        address.value = server;
        title.textContent = `正在连接 ${server}`;
        if (await tryConnect(server)) return true;
    }

    return false;
}

// Auto-connect on load. A saved choice wins; fresh installs prefer LAN and then WAN.
(async () => {
    console.log('Auto-connect: starting');

    await window.apiPromise;

    const savedServer = window.jmpInfo.settings.main.userWebClient;
    console.log('Auto-connect: savedServer =', savedServer);

    const candidates = savedServer
        ? [savedServer, ...DEFAULT_SERVERS]
        : DEFAULT_SERVERS;
    const connected = await autoConnect(candidates);
    if (!connected && isConnecting) showManualConnection(savedServer);
})();
