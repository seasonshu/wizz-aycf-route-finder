console.log("popup.js loaded");

const maxHops=3;
const minLayerOver=3;
const futureDays=3;
const debugItinerarySearch=false;

// Even when itinerary cache is disabled, route (page) cache remains enabled
const enableItineraryCache=false;

async function fetchDestinations(origin, silent = false) {
  if(! origin) {
    throw new Error(`fetchDestinations: origin cannot be empty`);
  }

  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const oneHourInMs = 60 * 60 * 1000;
    if (Date.now() - data.timestamp < oneHourInMs && data.routes) {
      const routesFromOrigin = data.routes.find(
        (route) => route.departureStation.id === origin
      );
      if (routesFromOrigin && routesFromOrigin.arrivalStations) {
        const destinationIds = routesFromOrigin.arrivalStations.map(
          (station) => station.id
        );
        if(! silent && debugItinerarySearch) {
          console.log(`Routes from ${origin}:`, destinationIds,` (cached)`);
        }
        return destinationIds;
      } else {
        throw new Error("Failed to fetch destinations for " + origin);
      }
    }
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      if (currentTab.url.includes("multipass.wizzair.com")) {
        chrome.tabs.sendMessage(
          currentTab.id,
          { action: "getDestinations", origin: origin },
          function (response) {
            if (response && response.routes) {
              const pageData = {
                routes: response.routes,
                timestamp: Date.now(),
              };
              localStorage.setItem("wizz_page_data", JSON.stringify(pageData));

              const routesFromOrigin = response.routes.find(
                (route) => route.departureStation.id === origin
              );
              if (routesFromOrigin && routesFromOrigin.arrivalStations) {
                const destinationIds = routesFromOrigin.arrivalStations.map(
                  (station) => station.id
                );
                if(! silent && debugItinerarySearch) {
                  console.log(`Routes from ${origin}:`, destinationIds);
                }
                resolve(destinationIds);
              } else {
                reject(new Error(`No routes found from ${origin}`));
              }
            } else if (response && response.error) {
              reject(new Error(response.error));
            } else {
              reject(new Error("Failed to fetch destinations for " + origin));
            }
          }
        );
      } else {
        chrome.tabs.create({
          url: "https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets",
        });
        reject(
          new Error(
            "Not on the Wizzair Multipass page. Opening the correct page for you. Please enter any random route and press Search."
          )
        );
      }
    });
  });
}

async function getDynamicUrl() {
  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const oneHourInMs = 60 * 60 * 1000;
    if (Date.now() - data.timestamp < oneHourInMs && data.dynamicUrl) {
      console.log("Using cached dynamic URL");
      return data.dynamicUrl;
    }
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      chrome.tabs.sendMessage(
        currentTab.id,
        { action: "getDynamicUrl" },
        function (response) {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else if (response && response.dynamicUrl) {
            const pageData = JSON.parse(
              localStorage.getItem("wizz_page_data") || "{}"
            );
            pageData.dynamicUrl = response.dynamicUrl;
            pageData.timestamp = Date.now();
            localStorage.setItem("wizz_page_data", JSON.stringify(pageData));
            resolve(response.dynamicUrl);
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            reject(new Error("Failed to get dynamic URL"));
          }
        }
      );
    });
  });
}

async function checkRoute(origin, destination, date, forceRefresh) {
  const cacheKey = makeCacheRouteKey(origin, destination, date);
  const cachedResults = getCachedResults(cacheKey);

  if (! forceRefresh && cachedResults) {
    console.log("checkRoute: Using cached results for origin=", origin, ", destination=", destination, ", date=", date);
    return cachedResults;
  }

  try {
    const delay = Math.floor(Math.random() * (1000 - 500 + 1)) + 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));

    const dynamicUrl = await getDynamicUrl();
    const pageData = JSON.parse(localStorage.getItem("wizz_page_data") || "{}");

    const data = {
      flightType: "OW",
      origin: origin,
      destination: destination,
      departure: date,
      arrival: "",
      intervalSubtype: null,
    };

    let headers = {
      'Content-Type': 'application/json',
    };

    const oneHourInMs = 60 * 60 * 1000;
    if (pageData.headers && Date.now() - pageData.timestamp < oneHourInMs) {
      console.log("Using cached headers");
      headers = { ...headers, ...pageData.headers };
    } else {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: "getHeaders" }, resolve);
      });
      if (response && response.headers) {
        headers = { ...headers, ...response.headers };
      } else {
        console.log("Failed to get headers from the page, using defaults");
      }
    }

    const fetchResponse = await fetch(dynamicUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(data),
    });

    // Code 400: Flight not available
    if (!fetchResponse.ok && fetchResponse.status != 400) {
      throw new Error(`HTTP error! status: ${fetchResponse.status}`);
    }

    const responseData = await fetchResponse.json();
    const flightsOutbound = responseData.flightsOutbound || [];
    setCachedResults(cacheKey, flightsOutbound);

    return flightsOutbound;
  } catch (error) {
    console.error("Error in checkRoute:", error);
    if (
      error.message.includes("429") ||
      error.message.includes("Rate limited")
    ) {
      control.isRateLimited = true;
      document.querySelector("#rate-limited-message").style.display = "block";
    }
    throw error;
  }
}

function makeCacheRouteKey(origin, destination, date) {
  return `VOLATILE_PAGE-${origin}-${destination}-${date}`;
}

function makeCacheItineraryKey(origin, destination, via, date) {
  return `VOLATILE_ITINERARY-${origin}-${destination}-${via}-${date}`;
}

function getCachedResultsItineraryKeys() {
  return Object.keys(localStorage).filter((key) =>
    key.match(/^VOLATILE_ITINERARY-/)
  );
}

function getCachedResultsKeys() {
  return Object.keys(localStorage).filter((key) =>
    key.match(/^VOLATILE_/)
  );
}

function setCachedResults(key, results) {
  const cacheData = {
    results: results,
    timestamp: Date.now(),
  };
  localStorage.setItem(key, JSON.stringify(cacheData));
}

function getCachedData(key) {
  const cachedData = localStorage.getItem(key);
  if (cachedData) {
    const { results, timestamp } = JSON.parse(cachedData);
    const eightHoursInMs = 8 * 60 * 60 * 1000;
    if (Date.now() - timestamp < eightHoursInMs) {
      return cachedData;
    } else {
      removeCachedResults(key, true);
    }
  }
  return null;
}

function getCachedResults(key) {
  const cachedData = getCachedData(key);
  if (cachedData) {
    const { results, timestamp } = JSON.parse(cachedData);
    return results;
  }
  return null;
}

function getCachedTimestamp(key) {
  const cachedData = getCachedData(key);
  if (cachedData) {
    const { results, timestamp } = JSON.parse(cachedData);
    return timestamp;
  }
  return null;
}

function removeCachedResults(key, setRefresh = false) {
  localStorage.removeItem(key);
  if(setRefresh && key.match(/^VOLATILE_ITINERARY-/)) {
    setCachedResults(key, "Refresh");
  }
}

function dateToISOString(date) {
  return date.toISOString().substring(0, 10);
}

function dateTimeToISOString(dateTime) {
  return dateTime.toISOString().substring(0, 19).replace('T', ' ');
}

// UTC offset was added instead of subtracted when creating the ISO time..
function fixUTCDateTime(dateTime, offsetText) {
  if(offsetText == "UTC") {
    return dateTime;
  }

  const tzDiff = offsetText.toString().substring(3);
  const dateTimeIso = new Date(dateTime.toString());
  dateTimeIso.setHours(dateTimeIso.getHours() - parseInt(tzDiff)*2);
  return dateTimeToISOString(dateTimeIso);
}

function calculateDuration(dateObj1, dateObj2) {
  const _MS_PER_HOUR = 1000 * 60 * 60;
  const _MS_PER_MIN = 1000 * 60;

  let date1 = new Date(dateObj1.toString());
  let date2 = new Date(dateObj2.toString());

  let diffMin = (date2.getTime() - date1.getTime()) / (1000 * 60);
  let hours = Math.floor(diffMin/60);
  let minutes =(diffMin%60);

  return hours.toString().padStart(2, "0") + "h " + minutes.toString().padStart(2, "0") + "m";
}

function incrementDate(dateObj, increment) {
  let date = new Date(dateObj.toString());
  let increasedDate = new Date(date.getTime() + (increment * 24*60*60*1000));
  return increasedDate;
}

function makeHopInput(origin, destination, arrival, date, earliestDepartureDateTimeUTC, forceRefresh, flightHopsPrev, maxHops, hopsLeft, daysLeft) {
  return {
    origin: origin,
    destination: destination,
    arrival:arrival,
    date:date,
    earliestDepartureDateTimeUTC: earliestDepartureDateTimeUTC,
    forceRefresh:forceRefresh,
    flightHopsPrev:flightHopsPrev,
    maxHops: maxHops,
    hopsLeft: hopsLeft,
    daysLeft: daysLeft,
  };
}

async function checkHop(params, control) {
  console.log("checkHop called for origin=", params.origin, ", destination=", params.destination, ", date=", params.date, ", forceRefresh=", params.forceRefresh);

  if (! control.flightsByDate[params.date]) {
    control.flightsByDate[params.date] = [];
  }

  let itineraryCompleted = false;
  const nextFlightLegInputs = [];

  try {
    if (control.isRateLimited) {
      return;
    }

    if (control.completedRoutes > 0 && control.completedRoutes % 25 === 0) {
      control.progressElement.textContent = `Taking a 15 second break to avoid rate limiting...`;
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const updateProgress = () => {
      control.progressElement.textContent = `Checking ${params.origin} to ${params.destination}... ${control.completedRoutes}/${control.destinationCnt}`;
    };

    const flights = await checkRoute(params.origin, params.destination, params.date, params.forceRefresh);
    if (flights && flights.length > 0) {
      flights.forEach((flight) => {
        // Touch upon sloppy data returned by server
        const departureDateTimeUTC = fixUTCDateTime(flight.departureDateTimeIso, flight.departureOffsetText);
        const arrivalDateTimeUTC = fixUTCDateTime(flight.arrivalDateTimeIso, flight.arrivalOffsetText);
        let duration = calculateDuration(departureDateTimeUTC, arrivalDateTimeUTC);
        // Calculate earliest next departure date and time
        const layerOverDateTimeIso = new Date(arrivalDateTimeUTC /*flight.arrivalDateTimeIso*/);
        layerOverDateTimeIso.setHours(layerOverDateTimeIso.getHours() + minLayerOver);
        const nextEarliestDepartureDateTimeIso = dateTimeToISOString(layerOverDateTimeIso);

        if(debugItinerarySearch) {
          console.log("Found flight=", flight);
          console.log("earliestDepartureDateTimeUTC=" + params.earliestDepartureDateTimeUTC);
//          console.log("flight.departureDateTimeIso=", flight.departureDateTimeIso);
//          console.log("flight.departureOffsetText=", flight.departureOffsetText);
          console.log("departureDateTimeUTC=" + departureDateTimeUTC);
//          console.log("flight.arrivalDateTimeIso=", flight.arrivalDateTimeIso);
//          console.log("flight.arrivalOffsetText=", flight.arrivalOffsetText);
          console.log("arrivalDateTimeUTC=", arrivalDateTimeUTC);
        }

        if(params.earliestDepartureDateTimeUTC && departureDateTimeUTC < params.earliestDepartureDateTimeUTC) {
          if(debugItinerarySearch) {
            console.log("Cannot make transfer, dropping flight");
          }
          return;
        }

        let flightDepartureDateText = "";
        let layoverDuration = null;
        if(params.flightHopsPrev.length > 0) {
          if(params.flightHopsPrev[0].date != params.date) {
            flightDepartureDateText = " on " +
            new Date(params.date).toLocaleDateString("en-US", {
              weekday: "short",
              day: "numeric",
              month: "short"
            });
          }

          layoverDuration = "--- wait " + calculateDuration(params.flightHopsPrev[0].arrivalDateTimeUTC, departureDateTimeUTC) + " ---";
        }

        const flightInfo = {
          origin: params.origin,
          departureStationText: flight.departureStationText,
          destination: params.destination,
          arrivalStationText: flight.arrivalStationText,
          flightCode: flight.flightCode,
          departureDateTimeUTC: departureDateTimeUTC,
          arrivalDateTimeUTC: arrivalDateTimeUTC,
          route: `${params.origin} (${flight.departureStationText}) to ${params.destination} (${flight.arrivalStationText}) - ${flight.flightCode} ${flightDepartureDateText}`,
          date: params.date,
          departure: `${flight.departure} (${flight.departureOffsetText})`,
          arrival: `${flight.arrival} (${flight.arrivalOffsetText})`,
          duration: duration,
          layoverDuration: layoverDuration,
        };

        const flightHops = [...params.flightHopsPrev, flightInfo];

        if(params.arrival && flight.arrivalStation != params.arrival) {
          if(params.hopsLeft > 1) {
            nextDepartureDate=dateToISOString(new Date(Date.parse(flight.arrivalDate)));
            const daysLeft = (params.date == nextDepartureDate) ? params.daysLeft : params.daysLeft - 1;
            const nextParams = makeHopInput(flight.arrivalStation, /*destination*/ null, params.arrival, nextDepartureDate, nextEarliestDepartureDateTimeIso, params.forceRefresh, flightHops, params.maxHops, params.hopsLeft-1, daysLeft);
            nextFlightLegInputs.push(nextParams);
          }
        } else {
          const routeText =
            (flightHops.length > 1)
            ?
            `${flightHops[0].origin} (${flightHops[0].departureStationText}) to ${flightHops[flightHops.length - 1].destination} (${flightHops[flightHops.length - 1].arrivalStationText})`
            :
            ""
          ;
          const stopsText = flightHops.length == 1 ? "Direct" : (flightHops.length - 1) + " stop" + ((flightHops.length - 1) > 1 ? "s" : "");
          const outDuration = calculateDuration(flightHops[0].departureDateTimeUTC, flightHops[flightHops.length - 1].arrivalDateTimeUTC);

          const itinerary = {
              route: routeText,
              out: {
                departure: `${flightHops[0].departure}`,
                arrival: `${flightHops[flightHops.length - 1].arrival}`,
                hops: flightHops.length,
                stopsText: stopsText,
                duration: outDuration,
                flights: flightHops,
              }
          };

          control.flightsByDate[flightHops[0].date] = [...control.flightsByDate[flightHops[0].date], itinerary];
          displayResults(control.flightsByDate[flightHops[0].date], true);
          itineraryCompleted = true;
        }
      });
    }

    control.completedRoutes++;
    updateProgress();
    await new Promise((resolve) => setTimeout(resolve, 200));

    if(! itineraryCompleted && params.flightHopsPrev.length > 0 && nextFlightLegInputs.length == 0) {
      // Could not find a suitable transfer for this day, try again for tomorrow
      if(params.daysLeft > 0) {
        if(debugItinerarySearch) {
          console.log("Retrying for the next day: " + dateToISOString(incrementDate(params.date, 1)) + " from origin" + params.origin);
        }
        const nextParams = makeHopInput(params.origin, params.destination, params.arrival, dateToISOString(incrementDate(params.date, 1)), params.earliestDepartureDateTimeUTC, params.forceRefresh, params.flightHopsPrev, params.maxHops, params.hopsLeft, params.daysLeft - 1);
        nextFlightLegInputs.push(nextParams);
      }
    }

    return nextFlightLegInputs;
  } catch (error) {
    console.error("Error in checkHop:", error);
    const routeListElement = document.querySelector(".route-list");
    routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
  }

}

async function findNextAirports(origin, arrival, via, maxHops, hopsLeft, control) {
  let nextAirports=[];
  const destinations = await fetchDestinations(origin);

  if(arrival && ! destinations.includes(arrival) && via.length == 0) {
    throw new Error("No direct flights from " + origin + " to " + arrival + ". Specify list of via airports or set it to ANY. Note: ANY will restrict the maximum number of hops to 2 to avoid excessive search.");
  }

  if(arrival && destinations.includes(arrival)) {
    nextAirports.push(arrival);
  }

  if(maxHops == 1 || hopsLeft > 1) {
    if(via.includes("ANY")) {
      nextAirports.push(...destinations);
    } else {
      nextAirports.push(...destinations.filter(item => maxHops == 1 || via.includes(item)));
    }
  }

  return nextAirports;
}

async function pushHopRequests(queue, hopRequest, via, control) {
  const nextAirports=await findNextAirports(hopRequest.origin, hopRequest.arrival, via, hopRequest.maxHops, hopRequest.hopsLeft, control);
  if(nextAirports.length == 0) {
    console.log("Unable to determine next hops from origin ", hopRequest.origin);
    return;
  }

  const hopRequests = [];
  for (const destination of nextAirports) {
    hopRequests.push(makeHopInput(hopRequest.origin, destination, hopRequest.arrival, hopRequest.date, hopRequest.earliestDepartureDateTimeUTC, hopRequest.forceRefresh, hopRequest.flightHopsPrev, hopRequest.maxHops, hopRequest.hopsLeft, hopRequest.daysLeft));
  }
  queue.push(...hopRequests);
  control.destinationCnt += hopRequests.length;
}

async function checkItinerary(origin, destination, arrival, via, date, control, forceRefresh) {
  const queue = [];
  const hops = (arrival || via.length > 0) ? (via.includes("ANY") ? 2 : maxHops) : 1;
  const days = futureDays - control.futureDaysOffset;
  await pushHopRequests(queue, makeHopInput(origin, destination, arrival, date, /*earliestDepartureDateTimeUTC*/ null, forceRefresh, [], hops, hops, days), via, control);

  // async function cannot call itself recursively
  while(queue.length > 0) {
    const job = queue.shift();

    const nextFlightLegInputs = await checkHop(job, control);
    if (nextFlightLegInputs) {
      for (const nextFlightLegInput of nextFlightLegInputs) {
        await pushHopRequests(queue, nextFlightLegInput, via, control);
      }
    }
  }
}

async function checkItineraries(origin, arrival, via, date, control, forceRefresh) {
  control.destinationCnt = 0;

  // Verify input
  await fetchDestinations(origin, true);
  for (const hop of via) {
    if(hop != "ANY") {
      await fetchDestinations(hop, true);
    }
  }
  if(arrival) {
    await fetchDestinations(arrival, true);
  }

  await checkItinerary(origin, /*destination*/ null, arrival, via, date, control, forceRefresh);
}

async function checkAllRoutes() {
  console.log("checkAllRoutes started");

  const audioCheckbox = document.getElementById("play-audio-checkbox");
  const audioPlayer = document.getElementById("background-music");
  if (audioCheckbox.checked && audioPlayer) {
    audioPlayer.play();
  }

  const originInput = document.getElementById("dep-airport-input");
  const arrivalInput = document.getElementById("arr-airport-input");
  const viaInput = document.getElementById("via-airport-input");
  const dateSelect = document.getElementById("date-select");
  const origin = originInput.value.toUpperCase();
  const arrival = arrivalInput.value.toUpperCase();
  const via = viaInput.value.toUpperCase().split(',').filter(item => item != "");
  const date = dateSelect.value;
  const futureDaysOffset = dateSelect.selectedIndex;

  if (!origin) {
    alert("Please enter a departure airport code.");
    return;
  }

  // Clear previous results
  const routeListElement = document.querySelector(".route-list");
  if (!routeListElement) {
    console.error("Error: .route-list element not found in the DOM");
    return;
  }

  document.querySelector("#rate-limited-message").style.display = "none";
  routeListElement.innerHTML = "";

  const cacheKey = makeCacheItineraryKey(origin, arrival, via, date);
  const cachedResults = enableItineraryCache ?
    getCachedResults(cacheKey)
    :
    getCachedResults(cacheKey) == "Refresh" ? "Refresh" : null
    ;
  const timestamp = getCachedTimestamp(cacheKey);
  let forceRefresh=false;

  if (cachedResults == "Refresh") {
    forceRefresh = true;
  } else if (cachedResults) {
    console.log("Using cached itinerary results for origin=", origin, ", arrival=", arrival, ", via=", via, ", date=", date);
    displayResults({ [date]: cachedResults });
    const routeListElement = document.querySelector(".route-list");
    const cacheNotification = document.createElement("div");
    cacheNotification.textContent =
      `Using cached results. Click the "Refresh Cache" button to fetch new data. Cache date: ${new Date(timestamp).toLocaleString()}`;
    cacheNotification.style.backgroundColor = "#e6f7ff";
    cacheNotification.style.border = "1px solid #91d5ff";
    cacheNotification.style.borderRadius = "4px";
    cacheNotification.style.padding = "10px";
    cacheNotification.style.marginBottom = "15px";
    routeListElement.insertBefore(
      cacheNotification,
      routeListElement.firstChild
    );

    // Stop and remove audio player when using cached results
    const audioPlayer = document.getElementById("background-music");
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.remove();
    }
    return;
  }

  try {
    const control = {
      progressElement : document.createElement("div"),
      flightsByDate : {},
      completedRoutes: 0,
      isRateLimited : false,
      destinationCnt : 0,
      futureDaysOffset: futureDaysOffset,
    }

    control.progressElement.id = "progress";
    control.progressElement.style.marginBottom = "10px";
    routeListElement.insertBefore(control.progressElement, routeListElement.firstChild);

    await checkItineraries(origin, arrival, via, date, control, forceRefresh);

    control.progressElement.remove();

    if (! control.isRateLimited) {
      if (! control.flightsByDate[date] || control.flightsByDate[date].length == 0) {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">No flights available on ${date}.</p>`;
      } else {
        setCachedResults(cacheKey, control.flightsByDate[date]);
        await displayResults(control.flightsByDate);
      }
    }
  } catch (error) {
    console.error("An error occurred:", error);
    routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
  }

  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.remove();
  }
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayResults(flightsByDate, append = false) {
  const resultsDiv = document.querySelector(".route-list");
  if (!resultsDiv) {
    console.error("Error: .route-list element not found in the DOM");
    return;
  }

  if (!append) {
    resultsDiv.innerHTML = "";
  }

  resultsDiv.style.fontFamily = "Arial, sans-serif";
  resultsDiv.style.maxWidth = "600px";
  resultsDiv.style.margin = "0 auto";

  for (const [date, itineraries] of Object.entries(flightsByDate)) {
    if (itineraries.length > 0) {
      let dateHeader = append
        ? resultsDiv.querySelector(`h3[data-date="${date}"]`)
        : null;
      let itineraryList = append
        ? resultsDiv.querySelector(`ul[data-date="${date}"]`)
        : null;

      if (!dateHeader) {
        dateHeader = document.createElement("h3");
        dateHeader.setAttribute("data-date", date);
        dateHeader.style.display = "flex";
        dateHeader.style.justifyContent = "space-between";
        dateHeader.style.alignItems = "center";
        dateHeader.style.backgroundColor = "#f0f0f0";
        dateHeader.style.padding = "10px";
        dateHeader.style.borderRadius = "5px";

        const dateText = document.createElement("span");
        dateText.textContent = new Date(date).toLocaleDateString("en-US", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
        dateHeader.appendChild(dateText);

        const clearCacheButton = document.createElement("button");
        clearCacheButton.textContent = "♻️ Refresh Cache";
        clearCacheButton.style.padding = "5px 10px";

        clearCacheButton.style.fontSize = "12px";
        clearCacheButton.style.backgroundColor = "#f0f0f0";
        clearCacheButton.style.border = "1px solid #ccc";
        clearCacheButton.style.borderRadius = "3px";
        clearCacheButton.style.cursor = "pointer";
        clearCacheButton.addEventListener("click", () => {
          const origin = document
            .getElementById("dep-airport-input")
            .value.toUpperCase();
          const destination = document
            .getElementById("arr-airport-input")
            .value.toUpperCase();
          const via = document
            .getElementById("via-airport-input")
            .value.toUpperCase();
          const cacheKey = makeCacheItineraryKey(origin, destination, via, date);
          removeCachedResults(cacheKey, true);
        });

        dateHeader.appendChild(clearCacheButton);
        resultsDiv.appendChild(dateHeader);
      }

      if (!itineraryList) {
        itineraryList = document.createElement("ul");
        itineraryList.setAttribute("data-date", date);
        itineraryList.style.listStyleType = "none";
        itineraryList.style.padding = "0";
        resultsDiv.appendChild(itineraryList);
      }

      const itinerariesToProcess = append ? [itineraries[itineraries.length - 1]] : itineraries;
      for (const itinerary of itinerariesToProcess) {
        const itineraryItem = document.createElement("li");
        itineraryItem.style.marginBottom = "15px";
        itineraryItem.style.padding = "10px";
        itineraryItem.style.border = "1px solid #ddd";
        itineraryItem.style.borderRadius = "5px";
        itineraryItem.style.display = "flex";
        itineraryItem.style.flexDirection = "column";
        itineraryItem.style.gap = "5px";

        itineraryList.appendChild(itineraryItem);
        itinerary.element = itineraryItem;

        const routeDiv = document.createElement("div");
        routeDiv.textContent = itinerary.route;
        routeDiv.style.fontWeight = "bold";
        routeDiv.style.marginBottom = "5px";
        itineraryItem.appendChild(routeDiv);

        const detailsDiv = document.createElement("div");
        detailsDiv.style.display = "flex";
        detailsDiv.style.justifyContent = "space-between";
        itineraryItem.appendChild(detailsDiv);

        const stopsDiv = document.createElement("div");
        stopsDiv.textContent = `️${itinerary.out.stopsText}`;

        const departureDiv = document.createElement("div");
        departureDiv.textContent = `✈️ ${itinerary.out.departure}`;

        const arrivalDiv = document.createElement("div");
        arrivalDiv.textContent = `🛬 ${itinerary.out.arrival}`;

        const durationDiv = document.createElement("div");
        durationDiv.textContent = `⏱️ ${itinerary.out.duration}`;

        detailsDiv.appendChild(stopsDiv);
        detailsDiv.appendChild(departureDiv);
        detailsDiv.appendChild(arrivalDiv);
        detailsDiv.appendChild(durationDiv);

        if (itinerary.out && Array.isArray(itinerary.out.flights)) {
          flightList = document.createElement("ul");
          flightList.setAttribute("data-date", date);
          flightList.style.listStyleType = "none";
          flightList.style.padding = "0";
          itineraryItem.appendChild(flightList);

          const flightItem = document.createElement("li");
          flightItem.style.marginBottom = "15px";
          flightItem.style.padding = "10px";
          flightItem.style.border = "1px solid #ddd";
          flightItem.style.borderRadius = "5px";
          flightItem.style.display = "flex";
          flightItem.style.flexDirection = "column";
          flightItem.style.gap = "5px";

          flightList.appendChild(flightItem);

          for (const flight of itinerary.out.flights) {
            if(flight.layoverDuration) {
              const layoverDiv = document.createElement("div");
              layoverDiv.style.fontWeight = "bold";
              layoverDiv.textContent = flight.layoverDuration;
              layoverDiv.style.textAlign = "center";
              flightItem.appendChild(layoverDiv);
            }
            const flightDiv = document.createElement("div");
            flightDiv.textContent = flight.route;
            flightDiv.style.fontWeight = "bold";
            flightDiv.style.marginBottom = "5px";
            flightItem.appendChild(flightDiv);

            const detailsDiv = document.createElement("div");
            detailsDiv.style.display = "flex";
            detailsDiv.style.justifyContent = "space-between";
            flightItem.appendChild(detailsDiv);

            const departureDiv = document.createElement("div");
            departureDiv.textContent = `✈️ Departure: ${flight.departure}`;

            const arrivalDiv = document.createElement("div");
            arrivalDiv.textContent = `🛬 Arrival: ${flight.arrival}`;

            const durationDiv = document.createElement("div");
            durationDiv.textContent = `⏱️ Duration: ${flight.duration}`;

            detailsDiv.appendChild(departureDiv);
            detailsDiv.appendChild(arrivalDiv);
            detailsDiv.appendChild(durationDiv);
          }

          const origin = document
            .getElementById("dep-airport-input")
            .value.toUpperCase();
          const returnCacheKey = `${origin}-${date}-return-${itinerary.route}`;
          const cachedReturnData = localStorage.getItem(returnCacheKey);

          if (!cachedReturnData) {
            const findReturnButton = document.createElement("button");
            findReturnButton.textContent = "Find Return";
            findReturnButton.style.width = "100px";
            findReturnButton.classList.add(
              "button",
              "is-small",
              "is-primary",
              "mt-2",
              "has-text-white",
              "has-text-weight-bold",
              "is-size-7"
            );
            findReturnButton.addEventListener("click", () => {
              itinerary.element = itineraryItem;
              findReturnFlight(itinerary);
              findReturnButton.remove();
            });
            flightItem.appendChild(findReturnButton);
          } else if (cachedReturnData) {
            const { results: returnFlights } = JSON.parse(cachedReturnData);
            itinerary.element = itineraryItem;
            displayReturnFlights(flight, returnFlights);
          }
        }
      }
    }
  }
}

async function findReturnFlight(outboundFlight) {
  const origin = outboundFlight.route.split(" to ")[1].split(" (")[0];
  const destination = outboundFlight.route.split(" to ")[0].split(" (")[0];
  const outboundDate = new Date(outboundFlight.date);
  const outboundArrivalTime = outboundFlight.arrival.split(" (")[0];

  const returnDates = [];
  for (let i = 0; i < 4; i++) {
    const date = new Date(outboundDate);
    date.setDate(outboundDate.getDate() + i);
    returnDates.push(formatDate(date));
  }

  const returnFlights = [];

  const progressElement = document.createElement("div");
  progressElement.classList.add("return-flight-progress");
  progressElement.style.marginTop = "10px";
  progressElement.style.fontSize = "0.9em";
  progressElement.style.color = "#000";
  outboundFlight.element.appendChild(progressElement);

  let checkedDates = 0;
  const updateProgress = () => {
    progressElement.textContent = `Checking return flights: ${checkedDates} of ${returnDates.length} dates checked...`;
  };

  updateProgress();

  for (const returnDate of returnDates) {
    console.log(`Checking return flights for ${returnDate}`);
    try {
      const flights = await checkRoute(origin, destination, returnDate, false);
      if (Array.isArray(flights)) {
        const validReturnFlights = flights.filter((flight) => {
          const [flightHours, flightMinutes] = flight.departure
            .split(" (")[0]
            .split(":");
          const flightDate = new Date(returnDate);
          flightDate.setHours(
            parseInt(flightHours, 10),
            parseInt(flightMinutes, 10),
            0,
            0
          );

          const [outboundHours, outboundMinutes] =
            outboundArrivalTime.split(":");
          const outboundArrival = new Date(outboundDate);
          outboundArrival.setHours(
            parseInt(outboundHours, 10),
            parseInt(outboundMinutes, 10),
            0,
            0
          );
          return flightDate > outboundArrival;
        });
        console.log(
          `Found ${validReturnFlights.length} valid return flights for ${returnDate}`
        );
        returnFlights.push(...validReturnFlights);
      } else {
        console.error(`Unexpected response format for ${returnDate}:`, flights);
      }
    } catch (error) {
      console.error(`Error checking return flight for ${returnDate}:`, error);
    }
    checkedDates++;
    updateProgress();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  progressElement.remove();

  console.log(`Total return flights found: ${returnFlights.length}`);
  displayReturnFlights(outboundFlight, returnFlights);

  return returnFlights;
}

function calculateTimeAtDestination(outboundFlight, returnFlight) {
  const outboundArrival = new Date(
    `${outboundFlight.date} ${outboundFlight.arrival.split(" (")[0]}`
  );
  const returnDeparture = new Date(
    `${returnFlight.departureDate} ${returnFlight.departure.split(" (")[0]}`
  );

  const timeDiff = returnDeparture - outboundArrival;
  const days = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );

  return `${days} days and ${hours} hours`;
}

function displayReturnFlights(outboundFlight, returnFlights) {
  const flightItem = outboundFlight.element;
  if (!flightItem) {
    console.error("Flight item element not found");
    return;
  }

  const existingReturnFlights = flightItem.querySelector(".return-flights");
  if (existingReturnFlights) {
    existingReturnFlights.remove();
  }

  const returnFlightsDiv = document.createElement("div");
  returnFlightsDiv.classList.add("return-flights");
  returnFlightsDiv.style.marginTop = "15px";
  returnFlightsDiv.style.borderTop = "2px solid #ddd";
  returnFlightsDiv.style.paddingTop = "15px";

  const validReturnFlights = returnFlights.filter((flight) => {
    const timeAtDestination = calculateTimeAtDestination(
      outboundFlight,
      flight
    );
    const [days, hours] = timeAtDestination.split(" and ");
    return parseInt(days) > 0 || parseInt(hours) >= 1;
  });

  const header = document.createElement("h4");
  header.textContent = `Return Flights (${validReturnFlights.length} found)`;
  header.style.marginBottom = "15px";
  header.style.fontWeight = "bold";
  returnFlightsDiv.appendChild(header);

  if (validReturnFlights.length === 0) {
    const noFlightsMsg = document.createElement("p");
    noFlightsMsg.textContent =
      "No valid (>1h until return) flights found within the next 3 days.";
    noFlightsMsg.style.fontStyle = "italic";
    returnFlightsDiv.appendChild(noFlightsMsg);
  } else {
    const flightList = document.createElement("ul");
    flightList.style.listStyleType = "none";
    flightList.style.padding = "0";

    validReturnFlights.forEach((flight) => {
      const returnFlightItem = document.createElement("li");
      returnFlightItem.style.marginBottom = "15px";
      returnFlightItem.style.padding = "10px";
      returnFlightItem.style.border = "1px solid #ddd";
      returnFlightItem.style.borderRadius = "5px";

      const routeDiv = document.createElement("div");
      routeDiv.textContent = `${
        flight.departureStationText || flight.departureStation
      } to ${flight.arrivalStationText || flight.arrivalStation} - ${
        flight.flightCode
      }`;
      routeDiv.style.fontWeight = "bold";
      routeDiv.style.marginBottom = "5px";

      const dateDiv = document.createElement("div");
      dateDiv.textContent = `Date: ${new Date(
        flight.departureDate
      ).toLocaleDateString()}`;
      dateDiv.style.fontSize = "0.9rem";
      dateDiv.style.color = "#4a4a4a";
      dateDiv.style.marginBottom = "5px";

      const detailsDiv = document.createElement("div");
      detailsDiv.style.display = "flex";
      detailsDiv.style.justifyContent = "space-between";
      detailsDiv.style.fontSize = "0.9em";

      const departureDiv = document.createElement("div");
      departureDiv.textContent = `✈️ Departure: ${flight.departure} (${
        flight.departureOffsetText || ""
      })`;

      const arrivalDiv = document.createElement("div");
      arrivalDiv.textContent = `🛬 Arrival: ${flight.arrival} (${
        flight.arrivalOffsetText || ""
      })`;

      const durationDiv = document.createElement("div");
      durationDiv.textContent = `⏱️ Duration: ${flight.duration}`;

      const timeAtDestinationDiv = document.createElement("div");
      const timeAtDestination = calculateTimeAtDestination(
        outboundFlight,
        flight
      );
      timeAtDestinationDiv.textContent = `🕒 Time until return: ${timeAtDestination}`;
      timeAtDestinationDiv.style.fontSize = "0.9em";
      timeAtDestinationDiv.style.color = "#4a4a4a";
      timeAtDestinationDiv.style.marginTop = "5px";

      detailsDiv.appendChild(departureDiv);
      detailsDiv.appendChild(arrivalDiv);
      detailsDiv.appendChild(durationDiv);

      returnFlightItem.appendChild(routeDiv);
      returnFlightItem.appendChild(dateDiv);
      returnFlightItem.appendChild(detailsDiv);
      returnFlightItem.appendChild(timeAtDestinationDiv);
      flightList.appendChild(returnFlightItem);
    });

    returnFlightsDiv.appendChild(flightList);
  }

  flightItem.appendChild(returnFlightsDiv);
}

function displayCacheButton() {
  const cacheButton = document.createElement("button");
  cacheButton.id = "show-cache";
  cacheButton.textContent = "Show Last Results (8h)";
  cacheButton.classList.add(
    "button",
    "has-background-primary",
    "mb-4",
    "ml-2",
    "has-text-white"
  );

  const searchFlightsButton = document.getElementById("search-flights");
  searchFlightsButton.parentNode.insertBefore(
    cacheButton,
    searchFlightsButton.nextSibling
  );

  cacheButton.addEventListener("click", showCachedResults);
}

function showCachedResults() {
  const cacheKeys = getCachedResultsItineraryKeys();

  const resultsDiv = document.querySelector(".route-list");
  resultsDiv.innerHTML = "";

  const headerContainer = document.createElement("div");
  headerContainer.style.display = "flex";
  headerContainer.style.justifyContent = "space-between";
  headerContainer.style.alignItems = "center";
  headerContainer.style.marginBottom = "4px";

  if (cacheKeys.length !== 0) {
    const header = document.createElement("h2");
    header.textContent = "Last Results (8h)";
    headerContainer.appendChild(header);
    const clearAllButton = document.createElement("button");
    clearAllButton.textContent = "Clear All";
    clearAllButton.classList.add("button", "is-small", "is-danger", "is-light");
    clearAllButton.addEventListener("click", clearAllCachedResults);
    headerContainer.appendChild(clearAllButton);
  }

  resultsDiv.appendChild(headerContainer);

  if (cacheKeys.length === 0) {
    const noResultsMessage = document.createElement("p");
    noResultsMessage.textContent = "Searched flights will appear here.";
    noResultsMessage.style.color = "#0f0f0f";
    resultsDiv.appendChild(noResultsMessage);
    return;
  }

  cacheKeys.forEach((key) => {
    const [type, origin, arrival, via, year, month, day] = key.split("-");
    const date = new Date(year, month - 1, day);
    const dayOfWeek = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ][date.getDay()];
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const formattedDate = `${dayOfWeek}, ${
      monthNames[date.getMonth()]
    } ${date.getDate()}`;

    const button = document.createElement("button");
    button.style.marginTop = "5px";
    button.textContent = `${origin} - ${formattedDate}`;
    button.classList.add("button", "is-small", "is-light", "mr-2", "mb-2");
    button.addEventListener("click", () => displayCachedResult(key));
    resultsDiv.appendChild(button);
  });
}

function clearAllCachedResults() {
  const cacheKeys = getCachedResultsKeys();

  cacheKeys.forEach((key) => {
    removeCachedResults(key);
  });

  const resultsDiv = document.querySelector(".route-list");
  resultsDiv.innerHTML = "<p>All cached results have been cleared.</p>";
}

function displayCachedResult(key) {
  const cachedResults = getCachedResults(key);
  const timestamp = getCachedTimestamp(key);
  if (cachedResults) {
    // Stop and remove audio player when displaying cached results
    const audioPlayer = document.getElementById("background-music");
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.remove();
    }

    const [origin, year, month, day] = key.split("-");
    const date = `${year}-${month}-${day}`;

    displayResults({ [date]: cachedResults });
    const routeListElement = document.querySelector(".route-list");

    const cacheNotification = document.createElement("div");
    cacheNotification.textContent =
      `Using cached results. Click the "Refresh Cache" button to fetch new data. Cache date: ${new Date(timestamp).toLocaleString()}`;
    cacheNotification.style.backgroundColor = "#e6f7ff";
    cacheNotification.style.border = "1px solid #91d5ff";
    cacheNotification.style.borderRadius = "4px";
    cacheNotification.style.padding = "10px";
    cacheNotification.style.marginBottom = "15px";
    routeListElement.insertBefore(
      cacheNotification,
      routeListElement.firstChild
    );

    cachedResults.forEach(async (flight) => {
      const returnCacheKey = `${key}-return-${flight.route}`;
      const cachedReturnResults = getCachedResults(returnCacheKey);
      if (cachedReturnResults) {
        displayReturnFlights(flight, cachedReturnResults);
      }
    });
  } else {
    alert("Cached data not found.");
  }
}

function checkCacheValidity() {
  const cacheKeys = getCachedResultsKeys();

  cacheKeys.forEach((key) => {
    getCachedResults(key);
  });
}

function isPageDataValid() {
  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const eightHoursInMs = 8 * 60 * 60 * 1000;
    return Date.now() - data.timestamp < eightHoursInMs;
  }
  return false;
}

function populateLastUsedInput(fieldId, cacheProperty) {
  const inputElement = document.getElementById(fieldId);
  const cacheValue = localStorage.getItem(cacheProperty);
  if (cacheValue) {
    inputElement.value = cacheValue;
  }

  inputElement.addEventListener("input", () => {
    localStorage.setItem(cacheProperty, inputElement.value.toUpperCase());
  });
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM content loaded");
  checkCacheValidity();
  const checkFlightsButton = document.getElementById("search-flights");
  const routeListElement = document.querySelector(".route-list");
  const audioCheckbox = document.getElementById("play-audio-checkbox");

  audioCheckbox.addEventListener("change", () => {
    const existingPlayer = document.getElementById("background-music");
    if (existingPlayer) {
      existingPlayer.remove();
    }
  });

  populateLastUsedInput("dep-airport-input", "lastDepAirport");
  populateLastUsedInput("arr-airport-input", "lastArrAirport");
  populateLastUsedInput("via-airport-input", "lastViaAirport");

  if (!routeListElement) {
    console.error("Error: .route-list element not found in the DOM");
  }

  if (checkFlightsButton) {
    console.log("Check Flights button found");
    checkFlightsButton.addEventListener("click", () => {
      console.log("Check Flights button clicked");

      if (audioCheckbox.checked) {
        const existingPlayer = document.getElementById("background-music");
        if (!existingPlayer) {
          const audioPlayer = document.createElement("audio");
          audioPlayer.id = "background-music";
          audioPlayer.controls = true;
          audioPlayer.loop = true;
          audioPlayer.style.position = "fixed";
          audioPlayer.style.bottom = "10px";
          audioPlayer.style.right = "10px";
          audioPlayer.style.transform = "none";
          audioPlayer.style.zIndex = "1000";
          audioPlayer.style.width = "150px";
          audioPlayer.style.height = "30px";
          audioPlayer.controlsList =
            "nodownload noplaybackrate nofullscreen noremoteplayback";
          audioPlayer.style.webkitMediaControls = "play current-time";

          const source = document.createElement("source");
          source.src = "assets/background-music.mp3";
          source.type = "audio/mpeg";

          audioPlayer.appendChild(source);
          document.body.appendChild(audioPlayer);
          audioPlayer.play();
        }
      }

      checkAllRoutes().catch((error) => {
        console.error("Error in checkAllRoutes:", error);
        if (routeListElement) {
          routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
        }
      });
    });
  } else {
    console.error("Check Flights button not found");
  }

  displayCacheButton();

  if (!isPageDataValid()) {
    localStorage.removeItem("wizz_page_data");
  }
});

document.addEventListener("DOMContentLoaded", function () {
  const dateSelect = document.getElementById("date-select");
  const today = new Date();

  for (let i = 0; i < 4; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const option = document.createElement("option");
    option.value = date.toISOString().split("T")[0];
    option.textContent = date.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });

    dateSelect.appendChild(option);
  }
});
