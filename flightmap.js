/* ============================================
   GOLDEN AGE AVIATION - LIVE FLIGHT MAP v2.1
   vAMSYS + SimBrief Integration
   ============================================ 
   
   BUGFIX v2.1:
   - Fixed pilot ID extraction from vAMSYS structure
   - Fixed airport coordinate extraction
   - Added debug logging for troubleshooting
   
   ============================================ */

// ============================================
// CONFIGURATION
// ============================================

const MAP_CONFIG = {
    apiBaseUrl: "https://api-golden-age-aviation-website.onrender.com",
    refreshInterval: 30000,
    defaultCenter: [20, 0],
    defaultZoom: 2,
    minZoom: 2,
    maxZoom: 18,
    fitBoundsMaxZoom: 8,
    fitBoundsPadding: [50, 50],
    zoomDuration: 0.8,
    panDuration: 0.5,
    debug: false
};

const FLIGHT_PHASES = {
    0: 'Preflight', 1: 'Boarding', 2: 'Pushback', 3: 'Taxi Out',
    4: 'Takeoff', 5: 'Climbing', 6: 'Cruising', 7: 'Descending',
    8: 'Approach', 9: 'Landing', 10: 'Taxi In', 11: 'Arrived', 12: 'Post-flight'
};

const PHASE_COLORS = {
    climbing: '#4ade80',
    cruising: '#9B59B6',
    descending: '#FF6B6B',
    taxi: '#60a5fa',
    default: '#E1A254'
};

// ============================================
// STATE
// ============================================

let flightMap = null;
let flightMarkers = {};
let routeLayers = {};
let waypointMarkers = {};
let selectedFlightId = null;
let flightsData = [];
let refreshTimer = null;

// ============================================
// DEBUG
// ============================================

function debugLog(...args) {
    if (MAP_CONFIG.debug) console.log('[FlightMap]', ...args);
}

function debugWarn(...args) {
    if (MAP_CONFIG.debug) console.warn('[FlightMap]', ...args);
}

// ============================================
// INITIALIZATION
// ============================================

function initFlightMap() {
    const mapContainer = document.getElementById('flightMap');
    if (!mapContainer) return;

    flightMap = L.map('flightMap', {
        center: MAP_CONFIG.defaultCenter,
        zoom: MAP_CONFIG.defaultZoom,
        minZoom: MAP_CONFIG.minZoom,
        maxZoom: MAP_CONFIG.maxZoom,
        zoomControl: true,
        attributionControl: false
    });

    setTimeout(() => flightMap.invalidateSize(), 200);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(flightMap);

    L.control.attribution({ position: 'bottomright', prefix: '' })
        .addTo(flightMap)
        .addAttribution('| <a href="https://vamsys.io/">vAMSYS</a>');

    flightMap.on('click', function() {
        if (selectedFlightId) deselectFlight();
    });

    loadFlightData();
    refreshTimer = setInterval(loadFlightData, MAP_CONFIG.refreshInterval);

    console.log('[FlightMap] Initialized v2.1');
}

// ============================================
// DATA LOADING
// ============================================

async function loadFlightData() {
    try {
        const response = await fetch(`${MAP_CONFIG.apiBaseUrl}/api/flights`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) throw new Error(`API returned ${response.status}`);

        const result = await response.json();
        
        if (result.data && Array.isArray(result.data)) {
            flightsData = result.data;
            
            // Debug: Log first flight to see vAMSYS structure
            if (MAP_CONFIG.debug && flightsData.length > 0) {
                debugLog('First flight object keys:', Object.keys(flightsData[0]));
                debugLog('departureAirport:', flightsData[0].departureAirport);
                debugLog('pilot:', flightsData[0].pilot);
            }
            
            renderFlights(flightsData);
        } else {
            flightsData = [];
            showNoFlightsMessage();
        }
    } catch (error) {
        console.error('[FlightMap] Error:', error);
        showNoFlightsMessage();
    }
}

// ============================================
// VAMSYS DATA EXTRACTION
// ============================================

function extractPilotId(flight) {
    // vAMSYS structure: pilot.id exists
    const pilotId = flight.pilot?.id ?? flight.pilotId ?? flight.booking?.pilotId ?? null;
    
    if (pilotId !== null && pilotId !== undefined) {
        debugLog(`Pilot ID: ${pilotId}`);
        return String(pilotId);
    }
    
    debugWarn('No pilot ID found');
    return null;
}

function extractVAPilotId(flight) {
    const pilotId = extractPilotId(flight);
    if (!pilotId) return null;
    
    const numericId = parseInt(pilotId, 10);
    if (!isNaN(numericId)) {
        return `GAA${String(numericId).padStart(4, '0')}`;
    }
    return pilotId;
}

function extractAirportData(airport) {
    if (!airport) {
        debugWarn('Airport object is null/undefined');
        return null;
    }
    
    // vAMSYS uses 'latitude' and 'longitude'
    const lat = airport.latitude ?? airport.lat ?? null;
    const lon = airport.longitude ?? airport.lon ?? airport.lng ?? null;
    const icao = airport.icao ?? airport.icao_code ?? airport.identifier ?? '';
    const name = airport.name ?? '';
    
    debugLog(`Airport extraction: icao=${icao}, lat=${lat}, lon=${lon}`);
    
    if (lat !== null && lon !== null && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
        return {
            lat: parseFloat(lat),
            lon: parseFloat(lon),
            icao: icao,
            name: name
        };
    }
    
    debugWarn('Invalid airport coordinates:', airport);
    return null;
}

function extractLocation(progress) {
    if (!progress) return null;
    
    const lat = progress.location?.lat ?? progress.latitude ?? progress.lat ?? null;
    const lon = progress.location?.lon ?? progress.location?.lng ?? progress.longitude ?? progress.lon ?? null;
    
    if (lat !== null && lon !== null && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
        return { lat: parseFloat(lat), lon: parseFloat(lon) };
    }
    return null;
}

// ============================================
// FLIGHT RENDERING
// ============================================

function renderFlights(flights) {
    updateFlightStats(flights.length);
    clearAllMarkers();
    
    const noFlightsMsg = document.querySelector('.no-flights-message');
    if (noFlightsMsg) noFlightsMsg.remove();

    if (flights.length === 0) {
        showNoFlightsMessage();
        closeFlightPanel();
        return;
    }

    flights.forEach(flight => {
        const location = extractLocation(flight.progress);
        if (location) addAircraftMarker(flight, location);
    });

    if (selectedFlightId) {
        const selectedFlight = flights.find(f => f.bookingId === selectedFlightId);
        if (selectedFlight) {
            // Only redraw if route doesn't already exist
            if (!routeLayers[selectedFlightId]) {
                drawFlightRoute(selectedFlight);
            }
            showFlightDetails(selectedFlight);
        } else {
            // Flight no longer exists
            deselectFlight();
        }
    }
}

function clearAllMarkers() {
    Object.values(flightMarkers).forEach(m => flightMap.removeLayer(m));
    flightMarkers = {};
    
    Object.values(routeLayers).forEach(l => flightMap.removeLayer(l));
    routeLayers = {};
    
    Object.values(waypointMarkers).forEach(arr => arr.forEach(m => flightMap.removeLayer(m)));
    waypointMarkers = {};
}

function addAircraftMarker(flight, location) {
    const bookingId = flight.bookingId;
    const heading = flight.progress?.magneticHeading || 0;
    const color = getFlightColor(flight);
    const isSelected = bookingId === selectedFlightId;
    const iconSize = isSelected ? 36 : 28;
    
    const icon = L.divIcon({
        className: 'aircraft-marker',
        html: `<div class="aircraft-icon ${isSelected ? 'selected' : ''}" style="width:${iconSize}px;height:${iconSize}px;">
            <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="${color}" style="transform: rotate(${heading}deg);">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
            </svg>
        </div>`,
        iconSize: [iconSize, iconSize],
        iconAnchor: [iconSize / 2, iconSize / 2]
    });

    const marker = L.marker([location.lat, location.lon], {
        icon: icon,
        zIndexOffset: isSelected ? 1000 : 0
    });

    marker.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        selectFlight(flight);
    });

    marker.addTo(flightMap);
    flightMarkers[bookingId] = marker;
}

// ============================================
// FLIGHT SELECTION & ZOOM
// ============================================

async function selectFlight(flight) {
    const bookingId = flight.bookingId;
    if (selectedFlightId === bookingId) return;
    
    // Clear previous selection completely
    if (selectedFlightId) {
        clearRouteForFlight(selectedFlightId);
    }
    
    // Set new selection
    selectedFlightId = bookingId;
    
    // Re-render markers with new selection highlight
    clearAllMarkers();
    flightsData.forEach(f => {
        const loc = extractLocation(f.progress);
        if (loc) addAircraftMarker(f, loc);
    });
    
    // Draw new route
    await drawFlightRoute(flight);
    showFlightDetails(flight);
    zoomToFlight(flight);
    
    debugLog(`Selected: ${bookingId}`);
}

function deselectFlight() {
    if (!selectedFlightId) return;
    
    const previousId = selectedFlightId;
    debugLog(`Deselecting flight: ${previousId}`);
    
    // Clear state FIRST
    selectedFlightId = null;
    
    // Clear route layers
    clearRouteForFlight(previousId);
    
    // Close panel (without triggering cleanup again - state already null)
    const panel = document.getElementById('flightDetailsPanel');
    if (panel) panel.classList.remove('active');
    
    // Reset zoom
    zoomToDefault();
    
    // Re-render markers without selection
    clearAllMarkers();
    flightsData.forEach(flight => {
        const location = extractLocation(flight.progress);
        if (location) addAircraftMarker(flight, location);
    });
    
    debugLog('Deselection complete');
}

function zoomToFlight(flight) {
    const depAirport = extractAirportData(flight.departureAirport);
    const arrAirport = extractAirportData(flight.arrivalAirport);
    const currentLoc = extractLocation(flight.progress);
    
    const points = [];
    if (depAirport) points.push([depAirport.lat, depAirport.lon]);
    if (currentLoc) points.push([currentLoc.lat, currentLoc.lon]);
    if (arrAirport) points.push([arrAirport.lat, arrAirport.lon]);
    
    if (points.length >= 2) {
        flightMap.fitBounds(L.latLngBounds(points), {
            padding: MAP_CONFIG.fitBoundsPadding,
            maxZoom: MAP_CONFIG.fitBoundsMaxZoom,
            animate: true,
            duration: MAP_CONFIG.zoomDuration
        });
    }
}

function zoomToDefault() {
    flightMap.setView(MAP_CONFIG.defaultCenter, MAP_CONFIG.defaultZoom, {
        animate: true,
        duration: MAP_CONFIG.panDuration
    });
    setTimeout(() => flightMap.invalidateSize(), 400);
}

// ============================================
// ROUTE DRAWING
// ============================================

async function drawFlightRoute(flight) {
    const bookingId = flight.bookingId;
    const pilotId = extractPilotId(flight);
    const vaPilotId = extractVAPilotId(flight);
    const depAirport = extractAirportData(flight.departureAirport);
    const arrAirport = extractAirportData(flight.arrivalAirport);
    const currentLoc = extractLocation(flight.progress);
    
    debugLog('Draw route:', { bookingId, pilotId, vaPilotId, depAirport, arrAirport, currentLoc });
    
    if (!currentLoc) {
        debugWarn('No current location - cannot draw route');
        return;
    }
    
    const color = getFlightColor(flight);
    
    // If no airport data, draw minimal route
    if (!depAirport || !arrAirport) {
        debugWarn('Missing airport data - drawing minimal route');
        drawMinimalRoute(bookingId, depAirport, arrAirport, currentLoc, color);
        return;
    }
    
    // If no pilot ID, skip SimBrief lookup
    if (!pilotId) {
        debugLog('No pilot ID - drawing fallback');
        drawFallbackRoute(bookingId, depAirport, arrAirport, currentLoc, color);
        return;
    }
    
    // Build params for backend
    const params = new URLSearchParams({
        dep_lat: depAirport.lat,
        dep_lon: depAirport.lon,
        dep_icao: depAirport.icao,
        arr_lat: arrAirport.lat,
        arr_lon: arrAirport.lon,
        arr_icao: arrAirport.icao
    });
    
    try {
        const lookupId = vaPilotId || pilotId;
        debugLog(`Fetching route for: ${lookupId}`);
        
        const response = await fetch(`${MAP_CONFIG.apiBaseUrl}/api/flight-route/${lookupId}?${params}`);
        
        if (!response.ok) throw new Error(`${response.status}`);
        
        const routeData = await response.json();
        debugLog('Route response:', routeData);
        
        if (routeData.has_simbrief && routeData.waypoints?.length >= 2) {
            debugLog(`SimBrief route: ${routeData.waypoints.length} waypoints`);
            drawSimbriefRoute(bookingId, routeData.waypoints, currentLoc, color);
        } else {
            debugLog('Fallback route');
            drawFallbackRoute(bookingId, depAirport, arrAirport, currentLoc, color);
        }
    } catch (error) {
        console.warn('[FlightMap] Route fetch failed:', error);
        drawFallbackRoute(bookingId, depAirport, arrAirport, currentLoc, color);
    }
}

function drawMinimalRoute(bookingId, depAirport, arrAirport, currentLoc, color) {
    const layers = [];
    
    if (depAirport) {
        const coords = greatCirclePoints(depAirport.lat, depAirport.lon, currentLoc.lat, currentLoc.lon, 30);
        layers.push(L.polyline(coords, { color, weight: 3, opacity: 0.9 }));
        layers.push(L.circleMarker([depAirport.lat, depAirport.lon], {
            radius: 8, fillColor: '#E1A254', color: '#47173D', weight: 3, fillOpacity: 1
        }).bindTooltip(depAirport.icao || 'DEP'));
    }
    
    if (arrAirport) {
        const coords = greatCirclePoints(currentLoc.lat, currentLoc.lon, arrAirport.lat, arrAirport.lon, 30);
        layers.push(L.polyline(coords, { color, weight: 2, opacity: 0.4, dashArray: '10, 10' }));
        layers.push(L.circleMarker([arrAirport.lat, arrAirport.lon], {
            radius: 8, fillColor: '#E1A254', color: '#47173D', weight: 3, fillOpacity: 1
        }).bindTooltip(arrAirport.icao || 'ARR'));
    }
    
    if (layers.length > 0) {
        routeLayers[bookingId] = L.layerGroup(layers).addTo(flightMap);
    }
}

function drawSimbriefRoute(bookingId, waypoints, currentLoc, color) {
    const layers = [];
    const markers = [];
    
    // DEBUG: Log waypoint structure to identify data issues
    console.log(`%c=== WAYPOINT DEBUG for ${bookingId} ===`, 'color: #E1A254; font-weight: bold');
    console.log(`Total waypoints received: ${waypoints.length}`);
    waypoints.slice(0, 5).forEach((wp, i) => {
        console.log(`  [${i}] ${wp.ident}: lat=${wp.lat} (${typeof wp.lat}), lon=${wp.lon} (${typeof wp.lon}), type=${wp.type || 'undefined'}`);
    });
    if (waypoints.length > 5) console.log(`  ... and ${waypoints.length - 5} more`);
    console.log(`%c=== END WAYPOINT DEBUG ===`, 'color: #E1A254');
    
    const routeCoords = buildGreatCircleRoute(waypoints);
    const currentIndex = findNearestPointIndex(routeCoords, currentLoc);
    
    // Completed portion (solid)
    if (currentIndex > 0) {
        layers.push(L.polyline(routeCoords.slice(0, currentIndex + 1), {
            color, weight: 3, opacity: 0.9, smoothFactor: 1
        }));
    }
    
    // Remaining portion (dashed)
    if (currentIndex < routeCoords.length - 1) {
        layers.push(L.polyline(routeCoords.slice(currentIndex), {
            color, weight: 2, opacity: 0.4, dashArray: '10, 10', smoothFactor: 1
        }));
    }
    
    // Waypoint markers with smart filtering
    const totalWaypoints = waypoints.length;
    const skipInterval = totalWaypoints > 20 ? 3 : (totalWaypoints > 10 ? 2 : 1);
    
    waypoints.forEach((wp, index) => {
        const isAirport = wp.type === 'airport' || wp.is_origin || wp.is_destination;
        const isFirst = index === 0;
        const isLast = index === totalWaypoints - 1;
        
        // Always show airports, first, last; skip others based on interval
        if (!isAirport && !isFirst && !isLast && index % skipInterval !== 0) {
            return;
        }
        
        // Skip TOC/TOD markers
        const ident = (wp.ident || '').toUpperCase();
        if (['TOC', 'TOD', 'T/C', 'T/D'].includes(ident)) {
            return;
        }
        
        // Validate coordinates before creating marker
        const lat = parseFloat(wp.lat);
        const lon = parseFloat(wp.lon);
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            console.warn(`[FlightMap] Invalid waypoint coords for ${ident}:`, wp);
            return;
        }
        
        // Create marker - larger and more visible
        const marker = L.circleMarker([lat, lon], {
            radius: isAirport ? 8 : 5,
            fillColor: isAirport ? '#E1A254' : '#ffffff',
            color: isAirport ? '#47173D' : '#E1A254',
            weight: isAirport ? 3 : 2,
            fillOpacity: 1
        });
        
        // Tooltip with ident label
        // Airports and endpoints always permanent; others based on filtered count
        const filteredCount = Math.ceil(totalWaypoints / skipInterval);
        const showPermanent = isAirport || isFirst || isLast || filteredCount <= 12;
        
        const label = isAirport ? `<strong>${wp.ident}</strong>` : wp.ident;
        marker.bindTooltip(label, {
            permanent: showPermanent,
            direction: 'top',
            offset: [0, -8],
            className: 'waypoint-label'
        });
        
        markers.push(marker);
    });
    
    // Add to map
    routeLayers[bookingId] = L.layerGroup([...layers, ...markers]).addTo(flightMap);
    waypointMarkers[bookingId] = markers;
    
    console.log(`%c[FlightMap] Route complete: ${layers.length} polylines, ${markers.length} waypoint markers`, 'color: #4ade80');
    debugLog(`Route drawn: ${markers.length} waypoints visible`);
}

function drawFallbackRoute(bookingId, depAirport, arrAirport, currentLoc, color) {
    const layers = [];
    
    // Completed
    const completedCoords = greatCirclePoints(depAirport.lat, depAirport.lon, currentLoc.lat, currentLoc.lon, 50);
    layers.push(L.polyline(completedCoords, { color, weight: 3, opacity: 0.9, smoothFactor: 1 }));
    
    // Remaining
    const remainingCoords = greatCirclePoints(currentLoc.lat, currentLoc.lon, arrAirport.lat, arrAirport.lon, 50);
    layers.push(L.polyline(remainingCoords, { color, weight: 2, opacity: 0.4, dashArray: '10, 10', smoothFactor: 1 }));
    
    // Markers
    layers.push(L.circleMarker([depAirport.lat, depAirport.lon], {
        radius: 8, fillColor: '#E1A254', color: '#47173D', weight: 3, fillOpacity: 1
    }).bindTooltip(depAirport.icao || 'DEP', { direction: 'top' }));
    
    layers.push(L.circleMarker([arrAirport.lat, arrAirport.lon], {
        radius: 8, fillColor: '#E1A254', color: '#47173D', weight: 3, fillOpacity: 1
    }).bindTooltip(arrAirport.icao || 'ARR', { direction: 'top' }));
    
    routeLayers[bookingId] = L.layerGroup(layers).addTo(flightMap);
    debugLog(`Fallback drawn: ${depAirport.icao} → ${arrAirport.icao}`);
}

function clearRouteForFlight(bookingId) {
    // Clear route polylines
    if (routeLayers[bookingId]) {
        flightMap.removeLayer(routeLayers[bookingId]);
        delete routeLayers[bookingId];
    }
    
    // Clear waypoint markers
    if (waypointMarkers[bookingId]) {
        waypointMarkers[bookingId].forEach(m => {
            if (flightMap.hasLayer(m)) flightMap.removeLayer(m);
        });
        delete waypointMarkers[bookingId];
    }
}

/**
 * Master cleanup - clears ALL route visuals and resets state.
 * Call this when panel closes or flight deselects.
 */
function cleanupFlightSelection() {
    // Clear route for previously selected flight
    if (selectedFlightId) {
        clearRouteForFlight(selectedFlightId);
    }
    
    // Clear ALL route layers (safety net)
    Object.keys(routeLayers).forEach(id => {
        if (routeLayers[id] && flightMap.hasLayer(routeLayers[id])) {
            flightMap.removeLayer(routeLayers[id]);
        }
        delete routeLayers[id];
    });
    
    // Clear ALL waypoint markers (safety net)
    Object.keys(waypointMarkers).forEach(id => {
        if (waypointMarkers[id]) {
            waypointMarkers[id].forEach(m => {
                if (flightMap.hasLayer(m)) flightMap.removeLayer(m);
            });
        }
        delete waypointMarkers[id];
    });
    
    // Reset state
    selectedFlightId = null;
    
    // Close panel
    closeFlightPanel();
    
    // Reset zoom
    zoomToDefault();
}

// ============================================
// GREAT CIRCLE
// ============================================

function greatCirclePoints(lat1, lon1, lat2, lon2, numPoints = 50) {
    const points = [];
    const toRad = Math.PI / 180;
    const toDeg = 180 / Math.PI;
    
    const dist = Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lon2 - lon1, 2));
    if (dist < 0.1) return [[lat1, lon1], [lat2, lon2]];
    
    const φ1 = lat1 * toRad, λ1 = lon1 * toRad;
    const φ2 = lat2 * toRad, λ2 = lon2 * toRad;
    
    const d = 2 * Math.asin(Math.sqrt(
        Math.pow(Math.sin((φ2 - φ1) / 2), 2) +
        Math.cos(φ1) * Math.cos(φ2) * Math.pow(Math.sin((λ2 - λ1) / 2), 2)
    ));
    
    if (d < 0.0001) return [[lat1, lon1], [lat2, lon2]];
    
    for (let i = 0; i <= numPoints; i++) {
        const f = i / numPoints;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        
        const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
        const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
        const z = A * Math.sin(φ1) + B * Math.sin(φ2);
        
        points.push([Math.atan2(z, Math.sqrt(x*x + y*y)) * toDeg, Math.atan2(y, x) * toDeg]);
    }
    
    return points;
}

function buildGreatCircleRoute(waypoints) {
    if (!waypoints || waypoints.length < 2) return [];
    
    const routeCoords = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
        const wp1 = waypoints[i], wp2 = waypoints[i + 1];
        const dist = Math.sqrt(Math.pow(wp2.lat - wp1.lat, 2) + Math.pow(wp2.lon - wp1.lon, 2));
        const numPoints = Math.max(10, Math.min(80, Math.floor(dist * 5)));
        const segmentPoints = greatCirclePoints(wp1.lat, wp1.lon, wp2.lat, wp2.lon, numPoints);
        if (i > 0 && segmentPoints.length > 0) segmentPoints.shift();
        routeCoords.push(...segmentPoints);
    }
    return routeCoords;
}

function findNearestPointIndex(routeCoords, currentLoc) {
    if (!routeCoords || routeCoords.length === 0) return 0;
    let nearestIndex = 0, minDist = Infinity;
    routeCoords.forEach((coord, index) => {
        const dist = Math.pow(coord[0] - currentLoc.lat, 2) + Math.pow(coord[1] - currentLoc.lon, 2);
        if (dist < minDist) { minDist = dist; nearestIndex = index; }
    });
    return nearestIndex;
}

// ============================================
// PANEL
// ============================================

function showFlightDetails(flight) {
    const panel = document.getElementById('flightDetailsPanel');
    if (!panel) return;

    const { bookingId, progress, pilot, booking, aircraft, departureAirport, arrivalAirport, phase } = flight;
    const depData = extractAirportData(departureAirport);
    const arrData = extractAirportData(arrivalAirport);

    const callsign = booking?.callsign || `GAA${bookingId}`;
    const depIcao = depData?.icao || '???';
    const depName = depData?.name || departureAirport?.name || '';
    const arrIcao = arrData?.icao || '???';
    const arrName = arrData?.name || arrivalAirport?.name || '';
    const pilotUsername = pilot?.username || 'Unknown';
    const pilotIdStr = pilot?.id ? `GAA${String(pilot.id).padStart(4, '0')}` : '';
    const pilotName = pilotIdStr ? `${pilotUsername} ${pilotIdStr}` : pilotUsername;
    const pilotRank = pilot?.rank?.name || pilot?.rank?.abbreviation || 'N/A';
    const aircraftName = aircraft?.name || aircraft?.type || 'Unknown';
    const aircraftReg = aircraft?.registration || 'N/A';
    const aircraftType = aircraft?.type || '';
    const altitude = progress?.altitude?.toLocaleString() || '0';
    const speed = progress?.groundSpeed || 0;
    const heading = progress?.magneticHeading || 0;
    const currentPhase = progress?.currentPhase || FLIGHT_PHASES[phase] || 'Unknown';
    const timeRemaining = progress?.timeRemaining || 'N/A';
    const network = booking?.network || 'Offline';
    const distance = progress?.routeDistance ? Math.round(progress.routeDistance) : 'N/A';
    const remaining = progress?.distanceRemaining ? Math.round(progress.distanceRemaining) : 'N/A';
    const color = getFlightColor(flight);

    let progressPercent = 0;
    if (progress?.routeDistance && progress?.distanceRemaining) {
        progressPercent = Math.round(((progress.routeDistance - progress.distanceRemaining) / progress.routeDistance) * 100);
    }

    panel.innerHTML = `
        <div class="panel-top-bar">
            <h3 class="panel-callsign">${callsign}</h3>
            <div class="panel-top-right">
                <span class="panel-phase" style="background: ${color}">${currentPhase}</span>
                <button class="panel-close" onclick="deselectFlight()">&times;</button>
            </div>
        </div>
        <div class="panel-route">
            <div class="route-airport"><span class="airport-code">${depIcao}</span><span class="airport-name">${depName}</span></div>
            <div class="route-arrow"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div>
            <div class="route-airport"><span class="airport-code">${arrIcao}</span><span class="airport-name">${arrName}</span></div>
        </div>
        <div class="panel-progress">
            <div class="progress-bar"><div class="progress-fill" style="width: ${progressPercent}%; background: ${color}"></div><div class="progress-plane" style="left: ${progressPercent}%">✈</div></div>
            <div class="progress-labels"><span>${distance !== 'N/A' ? distance + ' nm total' : ''}</span><span>${remaining !== 'N/A' ? remaining + ' nm left' : ''}</span></div>
        </div>
        <div class="panel-section"><h4>Pilot</h4>
            <div class="panel-row"><span class="row-label">Name</span><span class="row-value">${pilotName}</span></div>
            <div class="panel-row"><span class="row-label">Rank</span><span class="row-value">${pilotRank}</span></div>
            <div class="panel-row"><span class="row-label">Network</span><span class="row-value network-badge">${network}</span></div>
        </div>
        <div class="panel-section"><h4>Aircraft</h4>
            <div class="panel-row"><span class="row-label">Type</span><span class="row-value">${aircraftName}</span></div>
            <div class="panel-row"><span class="row-label">Registration</span><span class="row-value">${aircraftReg}</span></div>
            ${aircraftType ? `<div class="panel-row"><span class="row-label">ICAO Code</span><span class="row-value">${aircraftType}</span></div>` : ''}
        </div>
        <div class="panel-section"><h4>Flight Data</h4>
            <div class="panel-stats">
                <div class="stat-box"><span class="stat-value">${altitude}</span><span class="stat-label">Altitude (ft)</span></div>
                <div class="stat-box"><span class="stat-value">${speed}</span><span class="stat-label">Speed (kts)</span></div>
                <div class="stat-box"><span class="stat-value">${heading}°</span><span class="stat-label">Heading</span></div>
            </div>
            <div class="panel-row"><span class="row-label">Time Remaining</span><span class="row-value">${timeRemaining}</span></div>
        </div>
    `;
    panel.classList.add('active');
}

function closeFlightPanel() {
    const panel = document.getElementById('flightDetailsPanel');
    if (panel) panel.classList.remove('active');
    
    // CRITICAL: Also clean up selection state when panel closes
    if (selectedFlightId) {
        const previousId = selectedFlightId;
        selectedFlightId = null;  // Clear FIRST to prevent re-render loop
        clearRouteForFlight(previousId);
        zoomToDefault();
        
        // Re-render markers without selection highlight
        clearAllMarkers();
        flightsData.forEach(flight => {
            const location = extractLocation(flight.progress);
            if (location) addAircraftMarker(flight, location);
        });
        
        debugLog('Panel closed - cleaned up selection');
    }
}

// ============================================
// UTILITIES
// ============================================

function getFlightColor(flight) {
    const currentPhase = (flight.progress?.currentPhase || '').toLowerCase();
    const phase = flight.phase;
    
    if (currentPhase.includes('climb')) return PHASE_COLORS.climbing;
    if (currentPhase.includes('descend') || currentPhase.includes('approach')) return PHASE_COLORS.descending;
    if (currentPhase.includes('taxi')) return PHASE_COLORS.taxi;
    if (currentPhase.includes('cruis')) return PHASE_COLORS.cruising;
    
    if (phase === 5) return PHASE_COLORS.climbing;
    if (phase === 7 || phase === 8) return PHASE_COLORS.descending;
    if (phase === 3 || phase === 10) return PHASE_COLORS.taxi;
    if (phase === 6) return PHASE_COLORS.cruising;
    
    return PHASE_COLORS.default;
}

function updateFlightStats(count) {
    const el1 = document.getElementById('activeFlights');
    const el2 = document.getElementById('pilotsOnline');
    if (el1) el1.textContent = count;
    if (el2) el2.textContent = count;
}

function showNoFlightsMessage() {
    const wrapper = document.querySelector('.map-wrapper');
    if (!wrapper || document.querySelector('.no-flights-message')) return;
    
    const msg = document.createElement('div');
    msg.className = 'no-flights-message';
    msg.innerHTML = '<h3>No Active Flights</h3><p>Our pilots are resting. Check back soon!</p>';
    wrapper.appendChild(msg);
    updateFlightStats(0);
}

// ============================================
// EXPORTS
// ============================================

window.deselectFlight = deselectFlight;
window.closeFlightPanel = closeFlightPanel;

document.addEventListener('DOMContentLoaded', initFlightMap);
