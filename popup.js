console.log("popup.js loaded");

// one of 'en-US', 'en-GB', etc..
const locale=Intl.NumberFormat().resolvedOptions().locale;

// DEBUG
const debugItineraryRoutes=false;
const debugItinerarySearch=true;
const debugItineraryDates=false;

// CACHE
// Disable enableItineraryCache when debugging search behaviour
// Even when itinerary cache is disabled, route (page) cache remains enabled, avoiding repeated hits on the server
const enableItineraryCache=true;
const pageValidForHours=1;
const resultsValidForHours=8;

// CONST
const wizzair_aycf_page="https://multipass.wizzair.com/w6/subscriptions/spa/private-page/wallets";

const default_maxHops=3;
const default_minLayover=2;
const futureDays=3;

function extractDestinations(origin, silent, data, isCached) {
  const routesFromOrigin = data.routes.find(
    (route) => route.departureStation.id === origin
  );
  if (routesFromOrigin && routesFromOrigin.arrivalStations) {
    const destinationIds = routesFromOrigin.arrivalStations.map(
      (station) => station.id
    );
    if(! silent && debugItineraryRoutes) {
      console.log(`Routes from ${origin}:`, destinationIds, (isCached ? ` (cached)` : ``));
    }
    return destinationIds;
  } else {
    throw new Error(`No routes found from ${origin}`);
  }
}

async function fetchDestinations(origin, control, silent = false) {
  if(! origin) {
    throw new Error(`fetchDestinations: origin cannot be empty`);
  }

  const pageData = getCachedPageData("routes");

  if (pageData && pageData.routes) {
    return extractDestinations(origin, silent, pageData, true);
  }

  const message = "Establishing connection: retrieving routes";
  const updateProgress = () => {
    control.progressElement.textContent = message;
  };
  updateProgress();

  console.log(message);
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      if (currentTab.url && currentTab.url.includes("multipass.wizzair.com")) {
        chrome.tabs.sendMessage(
          currentTab.id,
          { action: "getDestinations", origin: origin },
          function (response) {
            if (chrome.runtime.lastError) {
              if(chrome.runtime.lastError.message == "Could not establish connection. Receiving end does not exist.") {
                console.log(chrome.runtime.lastError.message);
                reject({message: "Refresh page " + wizzair_aycf_page + " and log in if prompted"});
              } else {
                reject(chrome.runtime.lastError);
              }
            }

            if (response && response.routes) {
              const pageData = {
                routes: response.routes,
              };

              setCachedPageData("routes", pageData);

              const destinationIds = extractDestinations(origin, silent, response, false);
               if(destinationIds) {
                resolve(destinationIds);
              } else {
                reject(new Error(`No routes found from ${origin}`));
              }
            } else if (response && response.error) {
              reject(new Error(response.error));
            } else {
              reject(new Error("Failed to fetch destinations for " + origin + ". Try refreshing the wizzair.com page"));
            }
          }
        );
      } else {
        chrome.tabs.create({
          url: wizzair_aycf_page,
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

async function getDynamicUrl(control) {
  const pageData = getCachedPageData("dynamicUrl");
  if (pageData && pageData.dynamicUrl) {
    return pageData.dynamicUrl;
  }

  const message = "Establishing connection: getting dynamic URL";
  const updateProgress = () => {
    control.progressElement.textContent = message;
  };
  updateProgress();

  console.log(message);
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      chrome.tabs.sendMessage(
        currentTab.id,
        { action: "getDynamicUrl" },
        function (response) {
          if (chrome.runtime.lastError) {
            if(chrome.runtime.lastError.message == "Could not establish connection. Receiving end does not exist.") {
              console.log(chrome.runtime.lastError.message);
              reject({message: "Refresh page " + wizzair_aycf_page + " and log in if prompted"});
            } else {
              reject(chrome.runtime.lastError);
            }
          }

          if (response && response.dynamicUrl) {
            const pageData = {
              dynamicUrl: response.dynamicUrl,
            }
            setCachedPageData("dynamicUrl", pageData);
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

async function getHeaders(control) {
  const pageData = getCachedPageData("headers");
  if (pageData && pageData.headers) {
    return pageData.headers;
  }

  const message = "Establishing connection: getting headers";
  const updateProgress = () => {
    control.progressElement.textContent = message;
  };
  updateProgress();

  console.log(message);
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      chrome.tabs.sendMessage(
        currentTab.id,
        { action: "getHeaders" },
        function (response) {
          if (chrome.runtime.lastError) {
            if(chrome.runtime.lastError.message == "Could not establish connection. Receiving end does not exist.") {
                console.log(chrome.runtime.lastError.message);
                reject({message: "Refresh page " + wizzair_aycf_page + " and log in if prompted"});
            } else {
              reject(chrome.runtime.lastError);
            }
          }

          if (response && response.headers) {
            const pageData = {
              headers: response.headers,
            }
            setCachedPageData("headers", pageData);
            resolve(response.headers);
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            reject(new Error("Failed to get headers"));
          }
        }
      );
    });
  });
}

async function checkRoute(origin, destination, date, control) {
  const cacheKey = makeCacheRouteKey(origin, destination, date);
  const cachedData = getCachedData(cacheKey);

  if (cachedData) {
    const { data, timestamp } = JSON.parse(cachedData);

    if (  ! control.itinerary.forceRefresh
        ||
        (control.itinerary.forceRefresh && control.searchStarted <= timestamp)
    ) {
      console.log("checkRoute: Using cached results for origin=", origin, ", destination=", destination, ", date=", date);
      return { flights: data, timestamp };
    }
  }

  if (control.checkedRoutes > 0 && control.checkedRoutes % 25 === 0) {
    control.progressElement.textContent = `Taking a 15 second break to avoid rate limiting...`;
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }

  control.checkedRoutes++;
  if(debugItineraryRoutes) {
    console.log("checkRoute: Sending query to server for origin=", origin, ", destination=", destination, ", date=", date, "control.checkedRoutes=", control.checkedRoutes);
  }
  try {
    const delay = Math.floor(Math.random() * (1000 - 500 + 1)) + 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));

    const dynamicUrl = await getDynamicUrl(control);

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
    const responseHeaders = await getHeaders(control);
    headers = { ...headers, ...responseHeaders };

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

    // Code 400: Flight not available
    if (fetchResponse.status == 400) {
      if (responseData.code == 'error.availability') {
        console.log("Flight not available. Received code '" + responseData.code +  "'; responseData=" + JSON.stringify(responseData));
      } else if (responseData.code == 'PASS-0000') {
        console.log("Flight search exception. Received code '" + responseData.code +  "'; responseData=" + JSON.stringify(responseData));
      } else {
        console.log("Unknown error. Received code '" + responseData.code +  "'; responseData=" + JSON.stringify(responseData));
      }
      const noFlightsOutbound = [];
      setCachedResults(cacheKey, noFlightsOutbound);
      return { flights: noFlightsOutbound, timestamp: null };
    }

    const flightsOutbound = responseData.flightsOutbound || [];
    setCachedResults(cacheKey, flightsOutbound);

    return { flights: flightsOutbound, timestamp: null };
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
  return Object.keys(localStorage).filter((cacheKey) =>
    cacheKey.match(/^VOLATILE_ITINERARY-/)
  );
}

function getCachedResultsKeys() {
  return Object.keys(localStorage).filter((cacheKey) =>
    cacheKey.match(/^VOLATILE_/)
  );
}

function setCachedData(cacheKey, data) {
  const cacheData = {
    data: data,
    timestamp: Date.now(),
  };
  localStorage.setItem(cacheKey, JSON.stringify(cacheData));
}

function setCachedPageData(type, pageData) {
  setCachedData(type, pageData);
}

function setCachedResults(cacheKey, results) {
  setCachedData(cacheKey, results);
}

function getCachedData(cacheKey, validForHours = resultsValidForHours) {
  const cachedData = localStorage.getItem(cacheKey);
  if (cachedData) {
    const { data, timestamp } = JSON.parse(cachedData);
    const validHoursInMs = validForHours * 60 * 60 * 1000;
    if (Date.now() - timestamp < validHoursInMs) {
      return cachedData;
    } else {
      removeCachedResults(cacheKey, true);
    }
  }
  return null;
}

function getCachedPageData(type, validForHours = pageValidForHours) {
  const cachedData = getCachedData(type, validForHours);
  if (cachedData) {
    const { data, timestamp } = JSON.parse(cachedData);
    return data;
  }
  return null;
}

function getCachedResults(cacheKey, validForHours = resultsValidForHours) {
  const cachedData = getCachedData(cacheKey, validForHours);
  if (cachedData) {
    const { data, timestamp } = JSON.parse(cachedData);
    return data;
  }
  return null;
}

function getCachedTimestamp(cacheKey) {
  const cachedData = getCachedData(cacheKey, resultsValidForHours);
  if (cachedData) {
    const { data, timestamp } = JSON.parse(cachedData);
    return timestamp;
  }
  return null;
}

function removeCachedResults(cacheKey, setRefresh = false) {
  localStorage.removeItem(cacheKey);
  if(setRefresh && cacheKey.match(/^VOLATILE_ITINERARY-/)) {
    setCachedResults(cacheKey, "Refresh");
  }
}

function extractDateFromISOString(date) {
  return date.toISOString().substring(0, 10);
}

function extractDateTimeFromISOString(dateTime) {
  return dateTime.toISOString().substring(0, 19).replace('T', ' ');
}

function dateTimeToISOString(dateTime) {
  return dateTime.substring(0, 10) + 'T' + dateTime.substring(11, 19) + '.000Z';
}

// UTC offset was added instead of subtracted when creating the ISO time..
function extractTimeZone(offsetText) {
  if(offsetText == "UTC") {
    return 0;
  }

  return parseInt(offsetText.toString().substring(3));
}

function fixUTCDateTime(dateTime, offsetText) {
  tzOffset = extractTimeZone(offsetText);
  const dateTimeIso = new Date(dateTimeToISOString(dateTime));
  dateTimeIso.setHours(dateTimeIso.getHours() - tzOffset*2);
  return extractDateTimeFromISOString(dateTimeIso);
}

function calculateDuration(dateTimeObj1, dateTimeObj2) {
  const _MS_PER_DAY = 1000 * 60 * 60 * 24;
  const _MS_PER_HOUR = 1000 * 60 * 60;
  const _MS_PER_MIN = 1000 * 60;

  let date1 = new Date(dateTimeToISOString(dateTimeObj1));
  let date2 = new Date(dateTimeToISOString(dateTimeObj2));

  const diffMin = (date2.getTime() - date1.getTime()) / (1000 * 60);
  const days    = Math.floor( diffMin / (60 * 24));
  const hours   = Math.floor((diffMin % (60 * 24)) / (60));
  const minutes = (diffMin % 60);

  return new Intl.DurationFormat(locale, { style: "narrow" }).format(
    {
      days: days,
      hours: hours,
      minutes: minutes,
    }
  );
}

function incrementDate(dateObj, increment) {
  let date = new Date(dateObj);
  let increasedDate = new Date(date.getTime() + (increment * 24*60*60*1000));
  return increasedDate;
}

function formatDateLong(date) {
  return new Date(date).toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatDateShort(date) {
  return new Date(date).toLocaleDateString(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function formatDateShortWeekday(date) {
  return new Date(date).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function convertDateTimeToLocalISODate(dateTime, offsetText) {
  tzOffset = extractTimeZone(offsetText);
  const dateTimeIso = new Date(dateTimeToISOString(dateTime));
  dateTimeIso.setHours(dateTimeIso.getHours() + tzOffset);
  return extractDateFromISOString(dateTimeIso);
}

function convertDateTimeToLocalRegionalTime(dateTime, offsetText) {
  if(dateTime.length < 12) {
    // Assuming it only contains time, e.g. '03:53:51.123'
    // Prefix with any date so it can be parsed
    dateTime = '0000-01-01 ' + dateTime;
  }

  tzOffset = extractTimeZone(offsetText);
  const dateTimeIso = new Date(dateTimeToISOString(dateTime));
  dateTimeIso.setHours(dateTimeIso.getHours() + tzOffset);
  // adjust to local timezone of the browser so we get time in regional format
  var dateTimeLocal = new Date(dateTimeIso.getTime() + dateTimeIso.getTimezoneOffset() * 60 * 1000);
  return dateTimeLocal.toLocaleTimeString(locale, { timeStyle: "short"} );
}

function makeFlightName(origin, arrival, via) {
  return `${origin} ` + (arrival ? `- ${arrival} ` : ``) + (via.length > 0 ? ` (via: ` + (typeof(via) == "arrays" ? via.join(", ") : via) + `)` : ``);
}

function makeHopInput(origin, destination, arrival, date, earliestDepartureDateTimeUTC, latestDepartureDateTimeUTC, flightHopsPrev, maxHops, hopsLeft, daysLeft) {
  return {
    origin: origin,
    destination: destination,
    arrival: arrival,
    date: date,
    earliestDepartureDateTimeUTC: earliestDepartureDateTimeUTC,
    latestDepartureDateTimeUTC: latestDepartureDateTimeUTC,
    flightHopsPrev: flightHopsPrev,
    maxHops: maxHops,
    hopsLeft: hopsLeft,
    daysLeft: daysLeft,
  };
}

async function checkHop(params, control) {
  if(! control.runningSearchAllowed || control.isRateLimited) {
    return;
  }

  if(debugItinerarySearch) {
    console.log("checkHop called for origin=", params.origin, ", destination=", params.destination, ", date=", params.date);
  }

  if (! control.flightsByDate[params.date]) {
    control.flightsByDate[params.date] = [];
  }

  let itineraryCompleted = false;
  const nextFlightLegInputs = [];

  try {
    const updateProgress = () => {
      const dateFormatted = formatDateShortWeekday(params.date);
      control.progressElement.innerHTML  = `Itinerary ${control.currentItinerary}\r\n`;
      control.progressElement.innerHTML += `Checking ${params.origin} to ${params.destination} on ${dateFormatted}...\r\n`;
      control.progressElement.innerHTML += `Progress ${control.completedRoutes}/${control.destinationCnt} (${control.checkedRoutes} queries)\r\n`;
    };

    const { flights, timestamp } = await checkRoute(params.origin, params.destination, params.date, control);
    if (! flights || flights.length == 0) {
      if(debugItinerarySearch) {
        console.log("checkHop no flights were found for origin=", params.origin, ", destination=", params.destination, ", date=", params.date);
      }
    } else {
      if(debugItinerarySearch) {
        console.log("checkHop processing", flights.length, "flights for origin=", params.origin, ", destination=", params.destination, ", date=", params.date);
      }
      // Adjust destination count if there are more than one flights found
      control.destinationCnt += flights.length - 1;
      flights.forEach((flight) => {
        // Touch upon sloppy data returned by server
        const departureDateTimeUTC = fixUTCDateTime(flight.departureDateTimeIso, flight.departureOffsetText);
        const arrivalDateTimeUTC = fixUTCDateTime(flight.arrivalDateTimeIso, flight.arrivalOffsetText);
        let duration = calculateDuration(departureDateTimeUTC, arrivalDateTimeUTC);
        // Calculate earliest next departure date and time
        const minLayoverDateTimeUTC = new Date(dateTimeToISOString(arrivalDateTimeUTC) /*flight.arrivalDateTimeIso*/);
        minLayoverDateTimeUTC.setHours(minLayoverDateTimeUTC.getHours() + control.minLayover);
        const nextEarliestDepartureDateTimeUTC = extractDateTimeFromISOString(minLayoverDateTimeUTC);
        // Calculate latest next departure date and time
        let maxLayoverDateTimeUTC = null;
        if(control.maxLayover) {
          maxLayoverDateTimeUTC = new Date(dateTimeToISOString(arrivalDateTimeUTC) /*flight.arrivalDateTimeIso*/);
          maxLayoverDateTimeUTC.setHours(maxLayoverDateTimeUTC.getHours() + control.maxLayover);
        }
        const nextLatestDepartureDateTimeUTC = maxLayoverDateTimeUTC ? extractDateTimeFromISOString(maxLayoverDateTimeUTC) : null;

        if(debugItinerarySearch) {
          console.log("Considering", params.origin + "->" + params.destination, "flight, departureDateTimeUTC=", departureDateTimeUTC, ", arrivalDateTimeUTC=", arrivalDateTimeUTC);
        }
        if(debugItineraryDates) {
          console.log("Found flight=", flight);
          console.log("earliestDepartureDateTimeUTC=" + params.earliestDepartureDateTimeUTC);
          console.log("latestDepartureDateTimeUTC=" + params.latestDepartureDateTimeUTC);
//          console.log("flight.departureDateTimeIso=", flight.departureDateTimeIso);
//          console.log("flight.departureOffsetText=", flight.departureOffsetText);
          console.log("departureDateTimeUTC=" + departureDateTimeUTC);
//          console.log("flight.arrivalDateTimeIso=", flight.arrivalDateTimeIso);
//          console.log("flight.arrivalOffsetText=", flight.arrivalOffsetText);
          console.log("arrivalDateTimeUTC=", arrivalDateTimeUTC);
          console.log("nextEarliestDepartureDateTimeUTC=", nextEarliestDepartureDateTimeUTC);
          console.log("nextLatestDepartureDateTimeUTC=", nextLatestDepartureDateTimeUTC);
        }

        if(params.earliestDepartureDateTimeUTC && departureDateTimeUTC < params.earliestDepartureDateTimeUTC) {
          if(debugItinerarySearch) {
            console.log("Cannot make transfer, dropping. Flight departureDateTimeUTC=", departureDateTimeUTC, ", earliestDepartureDateTimeUTC=", params.earliestDepartureDateTimeUTC);
          }
          return;
        }

        if(params.latestDepartureDateTimeUTC && departureDateTimeUTC > params.latestDepartureDateTimeUTC) {
          if(debugItinerarySearch) {
            console.log("Flight change would take longer than the maximum layover time, dropping. Flight departureDateTimeUTC=", departureDateTimeUTC, ", latestDepartureDateTimeUTC=", params.latestDepartureDateTimeUTC);
          }
          return;
        }

        let flightDepartureDateText = "";
        let layoverDuration = null;
        if(params.flightHopsPrev.length > 0) {
          if(params.flightHopsPrev[0].date != params.date) {
            flightDepartureDateText = " on " + formatDateShort(params.date);
          }

          layoverDuration = "--- wait " + calculateDuration(params.flightHopsPrev[params.flightHopsPrev.length - 1].arrivalDateTimeUTC, departureDateTimeUTC) + " ---";
        }

        nextDepartureDate = convertDateTimeToLocalISODate(nextEarliestDepartureDateTimeUTC, flight.arrivalOffsetText);
        const daysLeft = (params.date == nextDepartureDate) ? params.daysLeft : params.daysLeft - 1;

        const departureFormatted = convertDateTimeToLocalRegionalTime(departureDateTimeUTC, flight.departureOffsetText);
        const arrivalFormatted = convertDateTimeToLocalRegionalTime(arrivalDateTimeUTC, flight.arrivalOffsetText);

        const flightHop = {
          origin: params.origin,
          departureStationText: flight.departureStationText,
          destination: params.destination,
          arrivalStationText: flight.arrivalStationText,
          flightCode: flight.flightCode,
          departureDateTimeUTC: departureDateTimeUTC,
          arrivalDateTimeUTC: arrivalDateTimeUTC,
          route: `${params.origin} (${flight.departureStationText}) to ${params.destination} (${flight.arrivalStationText}) - ${flight.flightCode} ${flightDepartureDateText}`,
          date: params.date,
          departure: `${departureFormatted} (${flight.departureOffsetText})`,
          arrival: `${arrivalFormatted} (${flight.arrivalOffsetText})`,
          duration: duration,
          layoverDuration: layoverDuration,
        };

        const flightHops = [...params.flightHopsPrev, flightHop];

        if(params.arrival && flight.arrivalStation != params.arrival) {
          if(params.hopsLeft > 1) {
            const nextParams = makeHopInput(flight.arrivalStation, /*destination*/ null, params.arrival, nextDepartureDate, nextEarliestDepartureDateTimeUTC, nextLatestDepartureDateTimeUTC, flightHops, params.maxHops, params.hopsLeft-1, daysLeft);
            nextFlightLegInputs.push(nextParams);
          }
        } else {
          const routeText = `${flightHops[0].origin} (${flightHops[0].departureStationText}) to ${flightHops[flightHops.length - 1].destination} (${flightHops[flightHops.length - 1].arrivalStationText})`;
          const stopsText = flightHops.length == 1 ? "Direct" : (flightHops.length - 1) + " stop" + ((flightHops.length - 1) > 1 ? "s" : "");
          const outDuration = calculateDuration(flightHops[0].departureDateTimeUTC, flightHops[flightHops.length - 1].arrivalDateTimeUTC);

          const oneWay = {
            route: routeText,
            origin: `${flightHops[0].origin}`,
            destination: `${flightHops[flightHops.length - 1].destination}`,
            departure: `${flightHops[0].departure}`,
            arrival: `${flightHops[flightHops.length - 1].arrival}`,
            hops: flightHops.length,
            stopsText: stopsText,
            duration: outDuration,
            flights: flightHops,
            departureDateTimeUTC: flightHops[0].departureDateTimeUTC,
            arrivalDateTimeUTC: flightHops[flightHops.length - 1].arrivalDateTimeUTC,
            earliestDepartureDateTimeUTC: nextEarliestDepartureDateTimeUTC,
            latestDepartureDateTimeUTC: nextLatestDepartureDateTimeUTC,
            daysLeft: daysLeft,
            maxHops: control.maxHops,
            maxHopsANY: control.maxHopsANY,
            minLayover: control.minLayover,
            maxLayover: control.maxLayover,
          };

          const itinerary = JSON.parse(JSON.stringify(control.itinerary));
          itinerary[control.direction] = oneWay;
          if(control.direction == "ret") {
            itinerary.timeAtDestination = calculateDuration(control.outArrivalDateTimeUTC, itinerary[control.direction].departureDateTimeUTC);
          }

          control.flightsByDate[flightHops[0].date].push(itinerary);
          if(control.direction == "out") {
            displayResults(control.flightsByDate, control.direction, /*flags*/ {append: true, dateToAppend: flightHops[0].date});
          } else {
            displayResults(control.flightsByDate, control.direction, /*flags*/ {append: true, dateToAppend: flightHops[0].date, outItineraryLI: control.itinerary.outItineraryLI});
          }
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
          console.log("Retrying for the next day: " + extractDateFromISOString(incrementDate(params.date, 1)) + " from origin " + params.origin);
        }
        const nextParams = makeHopInput(params.origin, params.destination, params.arrival, extractDateFromISOString(incrementDate(params.date, 1)), params.earliestDepartureDateTimeUTC, params.latestDepartureDateTimeUTC, params.flightHopsPrev, params.maxHops, params.hopsLeft, params.daysLeft - 1);
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

async function findNextAirports(hopRequest, control) {
  let nextAirports=[];
  const destinations = await fetchDestinations(hopRequest.origin, control);

  if(hopRequest.arrival && ! destinations.includes(hopRequest.arrival) && control.itinerary.via.length == 0) {
    throw new Error("No direct flights from " + hopRequest.origin + " to " + hopRequest.arrival + ". Specify list of via airports or set it to ANY");
  }

  if(hopRequest.arrival && destinations.includes(hopRequest.arrival)) {
    nextAirports.push(hopRequest.arrival);
  }

  if(hopRequest.maxHops == 1 || hopRequest.hopsLeft > 1) {
    if(control.itinerary.via.includes("ANY")) {
      nextAirports.push(...destinations.filter(item => item != hopRequest.arrival));
    } else {
      nextAirports.push(...destinations.filter(item =>
        (! hopRequest.arrival && hopRequest.maxHops == 1)
        ||
        (hopRequest.arrival && item != hopRequest.arrival && control.itinerary.via.includes(item)))
      );
    }
  }

  return nextAirports;
}

function cloneHopInputWithDestination(hopRequest, destination) {
  return makeHopInput(hopRequest.origin, destination, hopRequest.arrival, hopRequest.date, hopRequest.earliestDepartureDateTimeUTC, hopRequest.latestDepartureDateTimeUTC, hopRequest.flightHopsPrev, hopRequest.maxHops, hopRequest.hopsLeft, hopRequest.daysLeft);
}

async function pushHopRequest(queue, hopRequest, control) {
  if(hopRequest.destination) {
    queue.push(cloneHopInputWithDestination(hopRequest, hopRequest.destination));
    return;
  }

  const nextAirports=await findNextAirports(hopRequest, control);
  if(nextAirports.length == 0) {
    if(debugItineraryRoutes) {
      console.log("Unable to determine next hops from origin ", hopRequest.origin);
    }
    return;
  }

  const hopRequests = [];
  for (const destination of nextAirports) {
    hopRequests.push(cloneHopInputWithDestination(hopRequest, destination));
  }
  queue.push(...hopRequests);
}

async function pushHopRequests(queue, hopRequests, control) {
  for (const hopRequest of hopRequests) {
    await pushHopRequest(queue, hopRequest, control);
  }
}

async function checkItinerary(itineraryPlan, date, hops, control) {
  if(! control.runningSearchAllowed || control.isRateLimited) {
    return;
  }

  if(debugItinerarySearch) {
    console.log("checkItinerary called with itineraryPlan=", itineraryPlan);
  }
  const daysLeft = control.daysLeft;
  let queue = [];
  let nextQueue = [];


  let hopSequence = 0;
  for (const hopPlan of itineraryPlan) {
    let hopCnt = 0;
    control.currentItinerary = '';
    for (const hopPlan of itineraryPlan) {
      if(hopCnt == 0) {
        control.currentItinerary +=
          (hopCnt == hopSequence ? '<b>': '')
        + hopPlan.origin;
      }
      control.currentItinerary += '->';
      control.currentItinerary +=
         (hopCnt == hopSequence - 1 ? '<b>': '')
        + hopPlan.destination
        + (hopCnt == hopSequence ? '</b>': '')
      ;
      hopCnt++;
    }

    queue = [];

    // Add start of itinerary
    if(hopSequence++ == 0) {
      await pushHopRequest(nextQueue, makeHopInput(hopPlan.origin, hopPlan.destination, hopPlan.arrival, date, control.earliestReturnDepartureDateTimeUTC, /*latestDepartureDateTimeUTC*/null, [], hops, hops, daysLeft), control);
    }

    for (nextJob of nextQueue) {
      // stick to planned route when finding routes to next airports
      await pushHopRequest(queue, cloneHopInputWithDestination(nextJob, hopPlan.destination));
    }
    nextQueue = [];

    if(queue.length == 0) {
      // Unable to find all flights for this route, mark remaining hops as completed
      control.completedRoutes++;
    }

    while(queue.length > 0) {
      const job = queue.shift();

      const nextFlightLegInputs = await checkHop(job, control);
      if (nextFlightLegInputs) {
        // Process all flights of the day
        let hasNextDayCheck=false;
        for(nextFlightLegInput of nextFlightLegInputs) {
          if(nextFlightLegInput.origin == job.origin) {
            hasNextDayCheck=true;
            await pushHopRequest(queue, nextFlightLegInput, control);
          } else {
            nextQueue.push(nextFlightLegInput);
          }
        }
        if(hasNextDayCheck) {
          // Adjust destination to include next day's search
          control.destinationCnt++;
        }
      }
    }
  }
}

async function discoverHop(params, control, discoveredItineraries) {
  if(debugItineraryRoutes) {
    console.log("discoverHop called for origin=", params.origin, ", destination=", params.destination);
  }

  const nextFlightLegInputs = [];

  const flightHop = {
    origin: params.origin,
    destination: params.destination,
    arrival: params.arrival,
  };

  const flightHops = [...params.flightHopsPrev, flightHop];

  if(params.arrival && params.destination != params.arrival) {
    // Verify we haven't been to this airport yet
    for(flightHopPrev of params.flightHopsPrev) {
      if(params.destination == flightHopPrev.origin || params.destination == flightHopPrev.destination) {
        return;
      }
    }

    if(params.hopsLeft > 1) {
      const nextParams = makeHopInput(params.destination, /*destination*/ null, params.arrival, /*date*/null, /*earliestDepartureDateTimeUTC*/null, /*latestDepartureDateTimeUTC*/null, flightHops, params.maxHops, params.hopsLeft-1, params.daysLeft);
      nextFlightLegInputs.push(nextParams);
    }
  } else {
    discoveredItineraries.push(flightHops);
  }

  return nextFlightLegInputs;
}

async function discoverItinerary(origin, arrival, date, hops, control) {
  const queue = [];
  const discoveredItineraries = [];

  await pushHopRequest(queue, makeHopInput(origin, /*destination*/ null, arrival, /*date*/null, /*earliestDepartureDateTimeUTC*/null, /*latestDepartureDateTimeUTC*/null, [], hops, hops, null), control);

  // async function cannot call itself recursively
  while(queue.length > 0) {
    const job = queue.shift();

    const nextFlightLegInputs = await discoverHop(job, control, discoveredItineraries);
    if (nextFlightLegInputs) {
      await pushHopRequests(queue, nextFlightLegInputs, control);
    }
  }

  if(debugItinerarySearch) {
    console.log("discovered itineraries=", discoveredItineraries);
  }

  return discoveredItineraries;
}

async function checkItineraries(origin, arrival, date, control) {
  const hops = (arrival || control.itinerary.via.length > 0) ? (control.itinerary.via.includes("ANY") ? control.maxHopsANY : control.maxHops) : 1;

  // Verify input
  await fetchDestinations(origin, control, true);
  for (const hop of control.itinerary.via) {
    if(hop != "ANY") {
      await fetchDestinations(hop, control, true);
    }
  }
  if(arrival) {
    await fetchDestinations(arrival, control, true);
  }

  const discoveredItineraries = await discoverItinerary(origin, arrival, date, hops, control);

  for (const itineraryPlan of discoveredItineraries) {
    control.destinationCnt += itineraryPlan.length;
  }

  for (const itineraryPlan of discoveredItineraries) {
    await checkItinerary(itineraryPlan, date, hops, control);
  }
}

function displayCachedHeader(cacheKey, cachedResults) {
  const timestamp = getCachedTimestamp(cacheKey);

  const routeListElement = document.querySelector(".route-list");
  const cacheNotification = document.createElement("div");
  cacheNotification.textContent =
    `Using cached results. Click one of the "Refresh Cache" buttons to fetch new data. Cache date: ${new Date(timestamp).toLocaleString()}`;
  cacheNotification.style.backgroundColor = "#e6f7ff";
  cacheNotification.style.border = "1px solid #91d5ff";
  cacheNotification.style.borderRadius = "4px";
  cacheNotification.style.padding = "10px";
  cacheNotification.style.marginBottom = "15px";
  routeListElement.insertBefore(
    cacheNotification,
    routeListElement.firstChild
  );
}

function createProgressFrame(control) {
  const progressContainer = document.createElement("div");

  const progressElementContainer = document.createElement("div");
  progressElementContainer.style.display = "flex";
  progressElementContainer.style.justifyContent = "space-between";
  progressElementContainer.style.alignItems = "center";
  progressElementContainer.style.marginBottom = "4px";
  progressContainer.appendChild(progressElementContainer);

  progressElementContainer.appendChild(control.progressElement);

  const cancelButtonContainer = document.createElement("div");
  progressContainer.appendChild(cancelButtonContainer);

  const cancelButton = document.createElement("button");
  cancelButton.textContent = "Cancel";
  cancelButton.classList.add("button", "is-small", "is-danger", "is-light");
  cancelButton.addEventListener("click", () => cancelSearch(control));
  cancelButtonContainer.appendChild(cancelButton);

  return progressContainer;
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
  const depDateSelect = document.getElementById("dep-date-select");
  const maxHopsInput = document.getElementById("max-hops-input");
  const minLayoverInput = document.getElementById("min-layover-input");
  const maxLayoverInput = document.getElementById("max-layover-input");

  const origin = originInput.value.toUpperCase();
  const arrival = arrivalInput.value.toUpperCase();
  const via = viaInput.value.toUpperCase().split(',').map(e => e.trim()).filter(e => e != "");
  const depDate = depDateSelect.value;
  const daysLeft = futureDays - depDateSelect.selectedIndex;
  let maxHops = parseInt(maxHopsInput.value);
  if(maxHops < 1) maxHops = 1;
  if(maxHops > 4) maxHops = 4;
  let minLayover = parseInt(minLayoverInput.value);
  if(minLayover < 1) minLayover = 1;
  let maxLayover = parseInt(maxLayoverInput.value);
  if(maxLayover < 1) maxLayover = 1;

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

  const cacheKey = makeCacheItineraryKey(origin, arrival, via, depDate);
  const cachedResults = enableItineraryCache ?
    getCachedResults(cacheKey)
    :
    getCachedResults(cacheKey) == "Refresh" ? "Refresh" : null
    ;
  let forceRefresh=false;

  if (cachedResults == "Refresh") {
    forceRefresh = true;
  } else if (cachedResults) {
    console.log("Using cached itinerary results for origin=", origin, ", arrival=", arrival, ", via=", via, ", date=", depDate);

    displayResults(cachedResults);
    displayCachedHeader(cacheKey, cachedResults);

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
      searchStarted : Date.now(),
      runningSearchAllowed: true,
      progressElement : document.createElement("div"),
      flightsByDate : {},
      currentItinerary: null,
      checkedRoutes: 0,
      completedRoutes: 0,
      isRateLimited : false,
      destinationCnt : 0,
      direction: "out",
      outArrivalDateTimeUTC: null, /* not used in this context */
      earliestReturnDepartureDateTimeUTC: null, /* not used in this context */
      itinerary: {
        cacheKey: cacheKey,
        objectKey: crypto.randomUUID(),
        via: via,
        forceRefresh: forceRefresh,
      },
      daysLeft: daysLeft,
      maxHops: maxHops,
      maxHopsANY: maxHops,
      minLayover: minLayover,
      maxLayover: maxLayover,
    }

    control.progressElement.id = "progress";
    control.progressElement.style.marginBottom = "10px";
    control.progressElement.style.whiteSpace = "pre";
    const progressContainer = createProgressFrame(control);
    routeListElement.insertBefore(progressContainer, routeListElement.firstChild);

    await checkItineraries(origin, arrival, depDate, control);

    progressContainer.remove();

    if (! control.isRateLimited) {
      if (! control.flightsByDate[depDate] || control.flightsByDate[depDate].length == 0) {
        const noFlights =`No ` + makeFlightName(origin, arrival, via) + ` flights available`;
        displayResultsHeaderDate(routeListElement, depDate);

        const noResultsMessage = document.createElement("p");
        noResultsMessage.classList.add(
          "is-size-4",
          "has-text-centered",
        );
        noResultsMessage.textContent = noFlights;
        routeListElement.appendChild(noResultsMessage);
        setCachedResults(cacheKey, { [depDate] : `NoResult-${noFlights}` } );
      } else {
        setCachedResults(cacheKey, control.flightsByDate);
        await displayResults(control.flightsByDate);
      }
    }
  } catch (error) {
    console.error("Error in checkAllRoutes:", error);
    routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
  }

  if (audioPlayer) {
    audioPlayer.pause();
    audioPlayer.remove();
  }
}

function displayRefreshCacheButton(dateHeader, element, label, date, setRefresh) {
  const refreshCacheButton = document.createElement(element);
  refreshCacheButton.textContent = label;
  refreshCacheButton.style.padding = "5px 10px";

  refreshCacheButton.style.fontSize = "12px";
  refreshCacheButton.style.backgroundColor = "#f0f0f0";
  refreshCacheButton.style.border = "1px solid #ccc";
  refreshCacheButton.style.borderRadius = "3px";
  refreshCacheButton.style.cursor = "pointer";
  refreshCacheButton.addEventListener("click", () => {
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
    removeCachedResults(cacheKey, setRefresh);
  });

  dateHeader.appendChild(refreshCacheButton);
}

function displayResultsHeaderDate(resultsDiv, date, flags = {}, direction = "out") {
      let dateHeader = (flags.append || direction == "ret")
        ? resultsDiv.querySelector(`h3[data-date="${date}"]`)
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
        resultsDiv.appendChild(dateHeader);

        const dateText = document.createElement("span");
        dateText.textContent = ((direction == "ret") ? direction.toUpperCase() + ": " : "") + formatDateLong(date);
        dateHeader.appendChild(dateText);

        if(direction == "out") {
          displayRefreshCacheButton(dateHeader, "refreshItineraryButton", "♻️ Itinerary", date, false);
          displayRefreshCacheButton(dateHeader, "refreshItineraryAndRouteButton", "♻️ Itinerary+Route", date, true);
        }
      }

      return dateHeader;
}

function displayResults(flightsByDate, direction = "out", flags = {append: false, dateToAppend: null, outItineraryLI: null}) {
  const topRouteElement = document.querySelector(".route-list");
  if (! topRouteElement) {
    console.error("Error: .route-list element not found in the DOM");
    return;
  }

  topRouteElement.style.fontFamily = "Arial, sans-serif";
  topRouteElement.style.maxWidth = "600px";
  topRouteElement.style.margin = "0 auto";

  if(direction == "out") {
    if (! flags.append) {
      topRouteElement.innerHTML = "";
    }
  }

  if(direction == "ret" && ! flags.outItineraryLI) {
    console.log("displayResults: Error, flags.outItineraryLI must be set for direction=ret");
  }

  let flightsFound = 0;
  for (const [date, itineraries] of Object.entries(flightsByDate)) {
    flightsFound += itineraries.length;
  }

  if(direction == "ret" && flightsFound == 0) {
    let returnItineraryDiv = flags.outItineraryLI.querySelector(".return-flights");
    if (returnItineraryDiv) {
      returnItineraryDiv.remove();
    }

    returnItineraryDiv = document.createElement("div");
    returnItineraryDiv.classList.add("return-flights");
    returnItineraryDiv.style.marginTop = "15px";
    returnItineraryDiv.style.borderTop = "2px solid #ddd";
    returnItineraryDiv.style.paddingTop = "15px";
    flags.outItineraryLI.appendChild(returnItineraryDiv);

    const noFlightsMsg = document.createElement("p");
    noFlightsMsg.textContent =
      "No return flights found with the minimum layover in the next " + futureDays + " days";
    noFlightsMsg.style.fontStyle = "italic";
    returnItineraryDiv.appendChild(noFlightsMsg);
  }

  let itinerariesCnt = 0;
  for (const [date, itineraries] of Object.entries(flightsByDate)) {
    if (flags.dateToAppend && flags.dateToAppend != date) {
      continue;
    }

    if (typeof(itineraries) == "string" && itineraries.substring(0, 8) == "NoResult") {
      dateHeader = displayResultsHeaderDate(topRouteElement, date, flags, direction);

      const noResultsMessage = document.createElement("p");
      noResultsMessage.classList.add(
        "is-size-4",
        "has-text-centered",
      );
      noResultsMessage.textContent = itineraries.substring(9);
      topRouteElement.appendChild(noResultsMessage);
      return;
    }

    if (itineraries.length == 0) {
      continue;
    }

    const itinerariesToProcess = flags.append ? [itineraries[itineraries.length - 1]] : itineraries;
    for (const itinerary of itinerariesToProcess) {
      itinerariesCnt++;

      let returnHeader = null;
      let returnItineraryDiv = null;
      if(direction == "ret") {
        returnItineraryDiv = flags.outItineraryLI.querySelector(".return-flights");
      }

      if(direction == "ret" && (returnItineraryDiv == null || ! flags.append)) {
        if (itinerariesCnt == 1 && returnItineraryDiv) {
          returnItineraryDiv.remove();
          returnItineraryDiv = null;
        }

        if(! returnItineraryDiv) {
          returnItineraryDiv = document.createElement("div");
          returnItineraryDiv.classList.add("return-flights");
          returnItineraryDiv.style.marginTop = "15px";
          returnItineraryDiv.style.borderTop = "2px solid #ddd";
          returnItineraryDiv.style.paddingTop = "15px";
          flags.outItineraryLI.appendChild(returnItineraryDiv);

          returnTotal = document.createElement("h4");
          returnTotal.setAttribute("return-total", "");
          returnTotal.textContent = `Return Flights (${flightsFound} found)`;
          returnTotal.style.marginBottom = "15px";
          returnTotal.style.fontWeight = "bold";
          returnItineraryDiv.appendChild(returnTotal);
        }
      }

      if(direction == "ret") {
        returnTotal = returnItineraryDiv.querySelector(`h4[return-total=""]`)
        returnTotal.textContent = `Return Flights (${flightsFound} found)`;
      }

      const resultsDiv = (direction == "out") ? topRouteElement : returnItineraryDiv;

      let dateHeader = displayResultsHeaderDate(resultsDiv, date, flags, direction);

      let itineraryList = (flags.append || direction == "ret")
          ? resultsDiv.querySelector(`ul[data-date="${date}"]`)
          : null;

      if (! itineraryList) {
        itineraryList = document.createElement("ul");
        itineraryList.setAttribute("data-date", date);
        itineraryList.style.listStyleType = "none";
        itineraryList.style.padding = "0";
        resultsDiv.appendChild(itineraryList);
      }

      const itineraryItem = document.createElement("li");
      itineraryItem.style.marginBottom = "15px";
      itineraryItem.style.padding = "10px";
      itineraryItem.style.border = "1px solid #ddd";
      itineraryItem.style.borderRadius = "5px";
      itineraryItem.style.display = "flex";
      itineraryItem.style.flexDirection = "column";
      itineraryItem.style.gap = "5px";
      itineraryList.appendChild(itineraryItem);

      if (itinerary[direction] && Array.isArray(itinerary[direction].flights) && itinerary[direction].flights.length > 1) {
        const routeDiv = document.createElement("div");
        routeDiv.textContent = itinerary[direction].route;
        routeDiv.style.fontWeight = "bold";
        routeDiv.style.marginBottom = "5px";
        itineraryItem.appendChild(routeDiv);

        const stopsDiv = document.createElement("div");
        itineraryItem.appendChild(stopsDiv);
        stopsDiv.textContent = `️${itinerary[direction].stopsText}`;

        const detailsDiv = document.createElement("div");
        detailsDiv.style.display = "flex";
        detailsDiv.style.justifyContent = "space-between";
        itineraryItem.appendChild(detailsDiv);

        const durationDiv = document.createElement("div");
        detailsDiv.appendChild(durationDiv);
        durationDiv.textContent = `⏱️ ${itinerary[direction].duration}`;

        const departureDiv = document.createElement("div");
        detailsDiv.appendChild(departureDiv);
        departureDiv.textContent = `✈️ ${itinerary[direction].departure}`;

        const arrivalDiv = document.createElement("div");
        detailsDiv.appendChild(arrivalDiv);
        arrivalDiv.textContent = `🛬 ${itinerary[direction].arrival}`;
      }

      if (direction == "ret") {
        const timeAtDestinationDiv = document.createElement("div");
        itineraryItem.appendChild(timeAtDestinationDiv);
        timeAtDestinationDiv.textContent = `🕒 Time until return: ${itinerary.timeAtDestination}`;
        timeAtDestinationDiv.style.fontSize = "0.9em";
        timeAtDestinationDiv.style.color = "#4a4a4a";
        timeAtDestinationDiv.style.marginTop = "5px";
      }

      if (itinerary[direction] && Array.isArray(itinerary[direction].flights)) {
        let flightList = (flags.append || direction == "ret")
            ? itineraryItem.querySelector(`ul[data-date="${date}"]`)
            : null;

        if (! flightList) {
          flightList = document.createElement("ul");
          flightList.setAttribute("data-date", date);
          flightList.style.listStyleType = "none";
          flightList.style.padding = "0";
          itineraryItem.appendChild(flightList);
        }

        const flightItem = document.createElement("li");
        flightItem.style.marginBottom = "15px";
        flightItem.style.padding = "10px";
        flightItem.style.border = "1px solid #ddd";
        flightItem.style.borderRadius = "5px";
        flightItem.style.display = "flex";
        flightItem.style.flexDirection = "column";
        flightItem.style.gap = "5px";

        flightList.appendChild(flightItem);

        for (const flight of itinerary[direction].flights) {
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

        if(direction == "out") {
          if(itinerary["ret"] && itinerary["ret"].flights) {
            displayResults(itinerary["ret"].flights, "ret", /*flags*/ {append: false, dateToAppend: null, outItineraryLI: itineraryItem});
          } else {
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
              findReturnFlight(itinerary, itineraryItem);
              findReturnButton.remove();
            });
            flightItem.appendChild(findReturnButton);
          }
        }
      }
    }
  }
}

async function findReturnFlight(outboundItinerary, outItineraryLI) {
 console.log("findReturnFlight started");

  const origin = outboundItinerary["out"].destination;
  const arrival = outboundItinerary["out"].origin;
  const outboundDepartureDate = outboundItinerary["out"].flights[0].date;
  const outboundArrivalDate = outboundItinerary["out"].flights[outboundItinerary["out"].flights.length - 1].date;
  const returnDates = [];

  new Date(outboundArrivalDate)
  const dateSelect = document.getElementById("ret-date-select");

  let selectedReturnDate = dateSelect.value;
  let returnDaysLeft = dateSelect.length - 1 - dateSelect.selectedIndex;

  if(new Date(selectedReturnDate) < new Date(outboundArrivalDate)) {
    selectedReturnDate = outboundArrivalDate;
    returnDaysLeft = outboundItinerary["out"].daysLeft;
  }

  for (let i = 0; i <= returnDaysLeft; i++) {
    const date = new Date(selectedReturnDate);
    date.setDate(date.getDate() + i);
    returnDates.push(extractDateFromISOString(date));
  }

  const control = {
    searchStarted : Date.now(),
    runningSearchAllowed: true,
    progressElement : document.createElement("div"),
    flightsByDate : {},
    currentItinerary: null,
    checkedRoutes: 0,
    completedRoutes: 0,
    isRateLimited : false,
    destinationCnt : returnDates.length,
    direction: "ret",
    outArrivalDateTimeUTC: outboundItinerary["out"].arrivalDateTimeUTC,
    earliestReturnDepartureDateTimeUTC: outboundItinerary["out"].earliestDepartureDateTimeUTC,
    itinerary: {
      outItineraryLI: outItineraryLI,
      via: outboundItinerary.via,
      forceRefresh: outboundItinerary.forceRefresh,
    },
    daysLeft: returnDaysLeft,
    maxHops: outboundItinerary["out"].maxHops,
    maxHopsANY: outboundItinerary["out"].maxHopsANY,
    minLayover: outboundItinerary["out"].minLayover,
    maxLayover: outboundItinerary["out"].maxLayover,
  }

  control.progressElement.classList.add("return-flight-progress");
  control.progressElement.style.marginTop = "10px";
  control.progressElement.style.fontSize = "0.9em";
  control.progressElement.style.color = "#000";
  control.progressElement.style.whiteSpace = "pre";
  const progressContainer = createProgressFrame(control);
  outItineraryLI.appendChild(progressContainer);

  for (const returnDate of returnDates) {
    if(debugItinerarySearch) {
      const returnDateFormatted = extractDateFromISOString(new Date(returnDate));
      console.log(`Checking return flights for ${returnDateFormatted}`);
    }

    control.destinationCnt = control.destinationCnt - 1;

    try {
      await checkItineraries(origin, arrival, returnDate, control);
    } catch (error) {
      console.error("Error in findReturnFlight checking return flight for ${returnDate}:", error);
      const routeListElement = document.querySelector(".route-list");
      routeListElement.innerHTML = `<p>Error: ${error.message}</p>`;
    }

    // Adjust remaining days we can search
    control.daysLeft--;

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  outboundItinerary["ret"] = {
    flights: control.flightsByDate
  };

  const cachedResults = getCachedResults(outboundItinerary.cacheKey);

  cachedResults[outboundDepartureDate]
    .forEach((itinerary, seq) => {
      if (itinerary.objectKey == outboundItinerary.objectKey) {
        cachedResults[outboundDepartureDate][seq] = outboundItinerary;
      }
    });

  setCachedResults(outboundItinerary.cacheKey, cachedResults);
  progressContainer.remove();

  await displayResults(outboundItinerary["ret"].flights, "ret", /*flags*/ {append: false, dateToAppend: null, outItineraryLI: outItineraryLI});
}

function displayCacheButton() {
  const cacheButton = document.createElement("button");
  cacheButton.id = "show-cache";
  cacheButton.textContent = "Last Results (8h)";
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

function displayClearPageCacheButton() {
  const clearPageCacheButton = document.getElementById("clear-page-cache");
  if (clearPageCacheButton) {
    clearPageCacheButton.addEventListener("click", clearPageCache);
  }
}

function cancelSearch(control) {
  control.runningSearchAllowed = false;
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
  resultsDiv.appendChild(headerContainer);

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

  if (cacheKeys.length === 0) {
    const noResultsMessage = document.createElement("p");
    noResultsMessage.textContent = "Searched flights will appear here.";
    noResultsMessage.style.color = "#0f0f0f";
    resultsDiv.appendChild(noResultsMessage);
    return;
  }

  cacheKeys.forEach((cacheKey) => {
    const cachedResults = getCachedResults(cacheKey);
    if (cachedResults == "Refresh") {
      return;
    }

    const [type, origin, arrival, via, year, month, day] = cacheKey.split("-");
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

    const detailsDiv = document.createElement("div");
    detailsDiv.style.display = "flex";
    detailsDiv.style.justifyContent = "space-between";
    resultsDiv.appendChild(detailsDiv);

    const showButton = document.createElement("showButton");
    showButton.style.marginTop = "5px";
    showButton.textContent = makeFlightName(origin, arrival, via) + `- ${formattedDate}`;
    showButton.classList.add("button", "is-small", "is-light", "mr-2", "mb-2");
    showButton.addEventListener("click", () => displayCachedResult(cacheKey));
    detailsDiv.appendChild(showButton);

    const clearButton = document.createElement("clearButton");
    clearButton.style.marginTop = "5px";
    clearButton.textContent = "Remove";
    clearButton.classList.add("button", "is-small", "is-danger", "is-light");
    clearButton.addEventListener("click", () => clearCachedResult(cacheKey, showButton, clearButton));
    detailsDiv.appendChild(clearButton);
  });
}

function clearAllCachedResults() {
  const cacheKeys = getCachedResultsKeys();

  cacheKeys.forEach((cacheKey) => {
    removeCachedResults(cacheKey);
  });

  const resultsDiv = document.querySelector(".route-list");
  resultsDiv.innerHTML = "<p>All cached results have been cleared.</p>";
}

function displayCachedResult(cacheKey) {
  const cachedResults = getCachedResults(cacheKey);
  if (cachedResults) {
    // Stop and remove audio player when displaying cached results
    const audioPlayer = document.getElementById("background-music");
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.remove();
    }

    displayResults(cachedResults);
    displayCachedHeader(cacheKey, cachedResults);
  } else {
    alert("Cached data not found.");
  }
}

function clearCachedResult(cacheKey, showButton, clearButton) {
  const cachedResults = getCachedResults(cacheKey);
  const timestamp = getCachedTimestamp(cacheKey);
  if (cachedResults) {
      removeCachedResults(cacheKey);
      showButton.remove();
      clearButton.remove();
  } else {
    alert("Cached data not found.");
  }
}

function checkCacheValidity() {
  getCachedPageData("routes");
  getCachedPageData("dynamicUrl");
  getCachedPageData("headers");

  const cacheKeys = getCachedResultsKeys();
  cacheKeys.forEach((cacheKey) => {
    getCachedResults(cacheKey);
  });
}

function clearPageCache() {
console.log("Called clearPageCache");
  getCachedPageData("routes", 0);
  getCachedPageData("dynamicUrl", 0);
  getCachedPageData("headers", 0);
}

function populateLastUsedInput(fieldId, cacheProperty, defaultValue = null) {
  const inputElement = document.getElementById(fieldId);
  const cacheValue = localStorage.getItem(cacheProperty);
  if (cacheValue) {
    inputElement.value = cacheValue;
  } else {
    inputElement.value = defaultValue;
  }

  inputElement.addEventListener("input", () => {
    localStorage.setItem(cacheProperty, inputElement.value.toUpperCase());
  });

  inputElement.dispatchEvent(new Event('change'));
}

function populateDates(elementId, startDate, days) {
  const dateSelect = document.getElementById(elementId);
  Array.from(dateSelect.children).forEach(opt => opt.remove());

  for (let i = 0; i <= days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    const option = document.createElement("option");
    option.value = date.toISOString().split("T")[0];
    option.textContent = formatDateShort(date);

    dateSelect.appendChild(option);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM content loaded");
  checkCacheValidity();
  const checkFlightsButton = document.getElementById("search-flights");
  const settingsButton = document.getElementById("settings-button");
  const routeListElement = document.querySelector(".route-list");
  const audioCheckbox = document.getElementById("play-audio-checkbox");

  audioCheckbox.addEventListener("change", () => {
    const existingPlayer = document.getElementById("background-music");
    if (existingPlayer) {
      existingPlayer.remove();
    }
  });

  populateDates("dep-date-select", new Date(), futureDays);
  populateDates("ret-date-select", new Date(), futureDays);

  const depDateSelect = document.getElementById("dep-date-select");
  depDateSelect.addEventListener("change", () => {
    const retDateSelect = document.getElementById("ret-date-select");
    const currentRetDate = retDateSelect.value;

    const selectedOffset = depDateSelect.selectedIndex;
    populateDates("ret-date-select", depDateSelect.value, futureDays-selectedOffset);

    const newRetDateValue = depDateSelect.value > currentRetDate ? depDateSelect.value : currentRetDate;
    retDateSelect.value = newRetDateValue;
    if(retDateSelect.selectedIndex == -1) {
      retDateSelect.selectedIndex = 0;
    }
  });

  populateLastUsedInput("dep-airport-input", "lastDepAirport");
  populateLastUsedInput("arr-airport-input", "lastArrAirport");
  populateLastUsedInput("via-airport-input", "lastViaAirport");
  populateLastUsedInput("dep-date-select", "depDate", extractDateFromISOString(new Date()));
  populateLastUsedInput("ret-date-select", "retDate", extractDateFromISOString(new Date()));
  populateLastUsedInput("max-hops-input", "maxHops", default_maxHops);
  populateLastUsedInput("min-layover-input", "minLayover", default_minLayover);
  populateLastUsedInput("max-layover-input", "maxLayover");

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

      checkAllRoutes();
    });
  } else {
    console.error("Check Flights button not found");
  }

  if (settingsButton) {
    settingsButton.addEventListener("click", () => {
      console.log("Settings button clicked");

      const settingsGroupElement = document.querySelector("#settings-group");
      if (settingsGroupElement.style.display === "block") {
        settingsGroupElement.style.display = "none";
      } else {
        settingsGroupElement.style.display = "block";
      }
    });
  } else {
    console.error("Settings button not found");
  }

  displayCacheButton();
  displayClearPageCacheButton();
});
