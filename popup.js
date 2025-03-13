console.log("popup.js loaded");

async function fetchDestinations(origin) {
  const pageData = localStorage.getItem("wizz_page_data");
  if (pageData) {
    const data = JSON.parse(pageData);
    const oneHourInMs = 60 * 60 * 1000;
    if (Date.now() - data.timestamp < oneHourInMs && data.routes) {
      console.log("Using cached routes data");
      const routesFromOrigin = data.routes.find(
        (route) => route.departureStation.id === origin
      );
      if (routesFromOrigin && routesFromOrigin.arrivalStations) {
        const destinationIds = routesFromOrigin.arrivalStations.map(
          (station) => station.id
        );
        console.log(`Routes from ${origin}:`, destinationIds);
        return destinationIds;
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
                console.log(`Routes from ${origin}:`, destinationIds);
                resolve(destinationIds);
              } else {
                reject(new Error(`No routes found from ${origin}`));
              }
            } else if (response && response.error) {
              reject(new Error(response.error));
            } else {
              reject(new Error("Failed to fetch destinations"));
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

    if (!fetchResponse.ok) {
      throw new Error(`HTTP error! status: ${fetchResponse.status}`);
    }

    const responseData = await fetchResponse.json();
    const flightsOutbound = responseData.flightsOutbound || [];
    setCachedResults(cacheKey, flightsOutbound);

    return flightsOutbound;
  } catch (error) {
    console.error("Error in checkRoute:", error);
    if (error.message.includes("429")) {
      document.querySelector("#rate-limited-message").style.display = "block";
    }
    throw error;
  }
}

function makeCacheRouteKey(origin, destination, date) {
  return `VOLATILE_PAGE-${origin}-${destination}-${date}`;
}

function makeCacheItineraryKey(origin, date) {
  return `VOLATILE_ITINERARY-${origin}-${date}`;
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

async function checkFlights(origin, destination, date, control, forceRefresh) {
  console.log("checkFlights called for origin=", origin, ", destination=", destination, ", date=", date, ", forceRefresh=", forceRefresh);

  try {
    const flights = await checkRoute(origin, destination, date, forceRefresh);
    if (flights && flights.length > 0) {
      flights.forEach((flight) => {
        const flightInfo = {
          route: `${origin} (${flight.departureStationText}) to ${destination} (${flight.arrivalStationText}) - ${flight.flightCode}`,
          date: flight.departureDate,
          departure: `${flight.departure} (${flight.departureOffsetText})`,
          arrival: `${flight.arrival} (${flight.arrivalOffsetText})`,
          duration: flight.duration,
        };

        if (! control.flightsByDate[date]) {
          control.flightsByDate[date] = [];
        }
        control.flightsByDate[date].push(flightInfo);
        displayResults(control.flightsByDate, true);
      });
    }
  } catch (error) {
    console.error(
      `Error processing ${origin} to ${destination} on ${date}:`,
      error.message
    );

    if (
      error.message.includes("429") ||
      error.message.includes("Rate limited")
    ) {
      control.isRateLimited = true;
      document.querySelector("#rate-limited-message").style.display =
        "block";
    }
  }
}

async function checkItinerary(origin, destination, date, control, forceRefresh) {
  console.log("checkItinerary called for origin=", origin, ", destination=", destination, ", date=", date, ", forceRefresh=", forceRefresh);

  if (control.completedRoutes > 0 && control.completedRoutes % 25 === 0) {
    control.progressElement.textContent = `Taking a 15 second break to avoid rate limiting...`;
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }

  const updateProgress = () => {
    control.progressElement.textContent = `Checking ${origin} to ${destination}... ${control.completedRoutes}/${control.destinationCnt}`;
  };
  await checkFlights(origin, destination, date, control, forceRefresh);

  control.completedRoutes++;
  updateProgress();
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function checkAllRoutes() {
  console.log("checkAllRoutes started");

  const audioCheckbox = document.getElementById("play-audio-checkbox");
  const audioPlayer = document.getElementById("background-music");
  if (audioCheckbox.checked && audioPlayer) {
    audioPlayer.play();
  }

  const originInput = document.getElementById("airport-input");
  const dateSelect = document.getElementById("date-select");
  const origin = originInput.value.toUpperCase();
  const date = dateSelect.value;

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

  const cacheKey = makeCacheItineraryKey(origin, date);
  const cachedResults = getCachedResults(cacheKey);
  const timestamp = getCachedTimestamp(cacheKey);
  let forceRefresh=false;

  if (cachedResults == "Refresh") {
    forceRefresh = true;
  } else if (cachedResults) {
    console.log("Using cached itinerary results for origin=", origin, ", date=", date);
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
    const destinations = await fetchDestinations(origin);
    console.log("Fetched destinations:", destinations);

    const control = {
      progressElement : document.createElement("div"),
      flightsByDate : {},
      completedRoutes: 0,
      isRateLimited : false,
      destinationCnt : destinations.length,
    }

    control.progressElement.id = "progress";
    control.progressElement.style.marginBottom = "10px";
    routeListElement.insertBefore(control.progressElement, routeListElement.firstChild);

    for (const destination of destinations) {
      if (control.isRateLimited) break;

      await checkItinerary(origin, destination, date, control, forceRefresh);
    }

    control.progressElement.remove();

    if (! control.isRateLimited) {
      if (control.completedRoutes === 0) {
        routeListElement.innerHTML = `<p class="is-size-4 has-text-centered">No flights available for ${date}.</p>`;
      } else {
        setCachedResults(cacheKey, control.flightsByDate[date]);
        await displayResults(control.flightsByDate);
      }
    }
  } catch (error) {
    console.error("An error occurred:", error.message);
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

  for (const [date, flights] of Object.entries(flightsByDate)) {
    if (flights.length > 0) {
      let dateHeader = append
        ? resultsDiv.querySelector(`h3[data-date="${date}"]`)
        : null;
      let flightList = append
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
            .getElementById("airport-input")
            .value.toUpperCase();
          const cacheKey = makeCacheItineraryKey(origin, date);
          removeCachedResults(cacheKey, true);
        });

        dateHeader.appendChild(clearCacheButton);
        resultsDiv.appendChild(dateHeader);
      }

      if (!flightList) {
        flightList = document.createElement("ul");
        flightList.setAttribute("data-date", date);
        flightList.style.listStyleType = "none";
        flightList.style.padding = "0";
        resultsDiv.appendChild(flightList);
      }

      const flightsToProcess = append ? [flights[flights.length - 1]] : flights;

      for (const flight of flightsToProcess) {
        const flightItem = document.createElement("li");
        flightItem.style.marginBottom = "15px";
        flightItem.style.padding = "10px";
        flightItem.style.border = "1px solid #ddd";
        flightItem.style.borderRadius = "5px";
        flightItem.style.display = "flex";
        flightItem.style.flexDirection = "column";
        flightItem.style.gap = "5px";

        const routeDiv = document.createElement("div");
        routeDiv.textContent = flight.route;
        routeDiv.style.fontWeight = "bold";
        routeDiv.style.marginBottom = "5px";

        const detailsDiv = document.createElement("div");
        detailsDiv.style.display = "flex";
        detailsDiv.style.justifyContent = "space-between";

        const departureDiv = document.createElement("div");
        departureDiv.textContent = `✈️ Departure: ${flight.departure}`;

        const arrivalDiv = document.createElement("div");
        arrivalDiv.textContent = `🛬 Arrival: ${flight.arrival}`;

        const durationDiv = document.createElement("div");
        durationDiv.textContent = `⏱️ Duration: ${flight.duration}`;

        detailsDiv.appendChild(departureDiv);
        detailsDiv.appendChild(arrivalDiv);
        detailsDiv.appendChild(durationDiv);

        flightItem.appendChild(routeDiv);
        flightItem.appendChild(detailsDiv);

        const origin = document
          .getElementById("airport-input")
          .value.toUpperCase();
        const returnCacheKey = `${origin}-${date}-return-${flight.route}`;
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
            flight.element = flightItem;
            findReturnFlight(flight);
            findReturnButton.remove();
          });
          flightItem.appendChild(findReturnButton);
        } else if (cachedReturnData) {
          const { results: returnFlights } = JSON.parse(cachedReturnData);
          flight.element = flightItem;
          displayReturnFlights(flight, returnFlights);
        }

        flightList.appendChild(flightItem);
        flight.element = flightItem;
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
    const [type, origin, year, month, day] = key.split("-");
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

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM content loaded");
  checkCacheValidity();
  const checkFlightsButton = document.getElementById("search-flights");
  const routeListElement = document.querySelector(".route-list");
  const airportInput = document.getElementById("airport-input");
  const audioCheckbox = document.getElementById("play-audio-checkbox");

  audioCheckbox.addEventListener("change", () => {
    const existingPlayer = document.getElementById("background-music");
    if (existingPlayer) {
      existingPlayer.remove();
    }
  });

  const lastAirport = localStorage.getItem("lastAirport");
  if (lastAirport) {
    airportInput.value = lastAirport;
  }

  airportInput.addEventListener("input", () => {
    localStorage.setItem("lastAirport", airportInput.value.toUpperCase());
  });

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
