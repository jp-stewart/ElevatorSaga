    // Elevator Saga Code - Solution v4
    // J.P. Stewart - Feb 2022

    // Known issues:
    // Right now, because of some concurrency issues seen, sometimes the following bugs will occur:
    // - At times, more than one idle elevator is sent to the same floor button request
    // - At times, elevator assignment will appear locked, sending no elevators
    // 
    // For both known issues, they do not occur regularly, but instead, retrying the same level can make them go away.
    //

    // Known design flaws:
    // Right now, idle elevators are assigned in numberical order.
    // Smaller elevators are assigned first, so that larger ones can wait at floor 0, 
    //   because the game biases people at floor 0 across the whole game.
    // Ideally however, ALL idle elevators and floor requests would be calculated and matched _prior_ to sending the assignments.
    // The current design has a gap where a higher numerical elevator that may be closer is unfortunately missed.
    // The current design can still beat all levels, but is a slight improvement possibility for V5+

    // Known rule-bending:
    // This solution requires the use of the undocumented 'buttonstate_change' event on each floor.
    // Its absolutely required for knowing when request lights turn off. There is no other function in the game for determining this.
    // There is actually no good way of NOT sending multiple elevators repeatedly without this event and the saved results.

    // This function is called once in the begining by the game, and the only information provided are an array of all elevators and all floors
    // Inside, we will make our own duplicate copies of these objects just in case we want to change the ordering at some point in the future
    // (For example imagine if we could shift elevator and floor orders internally by availability or preference.)
{
    init: function(elevators, floors) 
    {

        //Internal array tracking elevators - index is elevator number
        var all_elevators = null;

        //Internal array tracking floors - index is floor number
        var all_floors = null;

        //Internal array tracking floor button requests - index is order of request, lowest first
        //Values are floor numbers, with positive values meaning up request, and negative values meaning down request
        var floor_buttons = null;

        //Internal array tracking when an elevator has committed to a certain floor & direction
        //Index is floor number - Values are elevator numbers plus 1, two saved per floor, 
        //  up direction in 1000s position & down direction in 1s position, all base 10
        var assignments = null;

        //Internal array tracking whether floor up or down lights are on, and how many times the button has been pressed
        //Index is floor number - values are number of times up or down was pressed, two saved per floor,
        //  up direction in 1000s position & down direction in 1s position, all base 10
        var floor_lights = null;

        //Attempt at tracking whether any external events have started the idle assignment loop recently.
        //Will be checked whenever any floor lights update
        var isAssignmentLoopRunning = false;


        //Function that sets inside elevator lights for indicating to boarding passengers which direction elevator will travel
        //Called only from stoppedAtFloor
        var setDirections = function(elevator, direction, floorNum = -1) 
        {
            if (floorNum == -1)
            {
                //just ask the elevator where it's at if a specific floor was not provided.
                floorNum = elevator.currentFloor();
            }
            if (floorNum == 0) {
                //elevators can only go up from the bottom
                elevator.goingUpIndicator(true);
                elevator.goingDownIndicator(false);
                elevator.directionLight = "up";
                return;
            } else if (floorNum == all_floors.length - 1) {
                //elevators can only go down from the top
                elevator.goingUpIndicator(false);
                elevator.goingDownIndicator(true);
                elevator.directionLight = "down";
                return;
            }

            //Check if this elevator is already going to other floors.
            var destinations = elevator.getPressedFloors();

            if (elevator.destinationQueue.length == 0 && destinations.length == 0)
            {               
                //If elevator has no current destinations planned or shown internally
                //then match the internal elevator lights to those on the floor
                //Yes, this mechanism biases towards up // an optimization would flip flop the biased default
                if (all_floors[floorNum].upLight) {
                    elevator.goingUpIndicator(true);  
                    elevator.goingDownIndicator(false);              
                } else if (all_floors[floorNum].downLight)
                {
                    elevator.goingUpIndicator(false);  
                    elevator.goingDownIndicator(true);    
                }

                return;
            }

            //There is a (small) chance of a bug here where the destinationQueue is empty, 
            //but somehow pressed floors is showing destinations. We will not solve for that now.

            //At the moment, the current implementation assumes the destination sorting logic below is working 
            //and merely checks for the next destination to see whether the elevator is going to go up or down.
            if (elevator.destinationQueue[0] >= floorNum)
            {
                elevator.goingUpIndicator(true);
                elevator.goingDownIndicator(false);
                elevator.directionLight = "up";
            }
            else
            {
                elevator.goingUpIndicator(false);
                elevator.goingDownIndicator(true);
                elevator.directionLight = "down";
            }

            //Save our own created direction cache within the elevator object
            elevator.directionLight = direction;
        };


        // Elevator assignment / commitment functions
        // The next three functions set / clear / check elevator commitments.
        // The goal of this is to prevent wasted trips / stops by other elevators.
        // All results are saved in the assignments array. Index is floor number.
        // Up commitments are saved as the elevator number + 1 in thousands, down commitments are just the elevator number + 1
    

        // Record an elevator commitment to a certain floor and direction request
        // ignoredup was meant for debugging purposes. Its largely true in places, but I left in for now
        var recordElevatorDestination = function(elevator,floorNum, direction, ignoredup = false)
        {
            //Check whether there is already a commitment for this floor
            if (checkElevatorDestination(floorNum,direction) > -1)
            {
                //If told to ignore duplicate requests... do nothing
                //In reality, because of when this function is called, IF there is a bug and that other elevator does not
                //actually visit that floor / direction, this will cause a problem because that person / floor
                //will end up ignored.

                // I found minimal cases of this in testing, but they do exist.
                // I do not yet know the full reasons or locations of bugs in the code that cause this.
                if (ignoredup) return;
                
                // If asked not to ignore duplicates, hard stop the whole program in the debugger here.
                debugger;

                return;
            }

            // There are known places in the code today, where concurrency seems to cause extra assignments 
            // and/or places where two elevators get assigned to the same floor.
            // Ideally there would be easier ways to put locks around this, but javascript does not offer that today.
            // Thus, for now, I will simply notate **LOCK** and **UNLOCK** where they should be.
            //**LOCK**

            var assignmentValue = null;

            if (direction == "down")
            {
                //Note that this will either initialize or overwrite an existing commitment if present for the down direction
                if (assignments[floorNum] == null || assignments[floorNum] == undefined || assignments[floorNum] < 1000)
                {
                    assignmentValue = elevator.number + 1;
                }
                else
                {
                    //Otherwise, there may be a commitment for the up direction we need to leave in place
                    assignmentValue = assignments[floorNum] + elevator.number + 1;
                }
            }
            else
            {
                //Note that this will either initialize or overwrite an existing commitment if present for the up direction
                if (assignments[floorNum] == null || assignments[floorNum] == undefined 
                    || assignments[floorNum] <= 0 || assignments[floorNum] % 1000 == 0)
                {
                    assignmentValue = (elevator.number + 1) * 1000;
                }
                else
                {
                    //Otherwise, there may be a commitment for the down direction we need to leave in place
                    //Use modulus operator just to be save and reset any errant up direction value.
                    assignmentValue = (assignments[floorNum] % 1000) + ((elevator.number + 1) * 1000);
                }
            }
            assignments[floorNum] = assignmentValue;

            //**UNLOCK**
            
        };

        // Clear an elevator commitment at a certain floor and direction.
        // This is only called from updateButtons whenever a request light turns OFF 
        var clearElevatorDestination = function(floorNum, direction)
        {
            var newValue = null;

            // Catch errors where somehow the code is clearing a floor where an elevator was never sent
            // Thankfully, I have never hit this assert in testing
            if (assignments[floorNum] == undefined || assignments[floorNum] == null || assignments[floorNum] == "" || assignments[floorNum] == 0)
            {
                debugger;
            }

            //**LOCK** (see comment in recordElevatorDestination)

            if (direction == "down")
            {
                //Leave the up in place if it exists (in thousands) -- or just set to zero if only down existed.
                newValue = assignments[floorNum] - (assignments[floorNum] % 1000);
            }
            else
            {
                //Remove anything over 1000.. which leaves the down commitment if present
                newValue = assignments[floorNum] % 1000;                
            }

            // Likely this block not needed, but for debugging, wanted to null out completly cleared floors
            if (newValue == 0)
            {
                assignments[floorNum] = null;
            }
            else
            {
                assignments[floorNum] = newValue;
            }

            //**UNLOCK** (see comment in recordElevatorDestination)
             
        };

        // Returns the elevator number of a committed elevator for a certain floor and direction.
        // If there is no match or commitment found, returns -1.
        var checkElevatorDestination = function(floorNum, direction)
        {
            var elevatorNum = -1;

            //No match if not set / undefined / or zero
            if (assignments[floorNum] == undefined || assignments[floorNum] == null || assignments[floorNum] == "" || assignments[floorNum] == 0)
            {
                return -1;
            }

            //**LOCK** (see comment in recordElevatorDestination)

            if (direction == "down")
            {
                //This will ignore / eliminate anything in thousands, and only return the lower values
                //If zero, it will end up as -1 below anyways.
                elevatorNum = assignments[floorNum] % 1000;
            }
            else
            {
                //No match if there is nothing in thousands
                if (assignments[floorNum] < 1000) return -1;

                //else, this essentially moves the decimal position to the left 3 places
                elevatorNum = Math.round(assignments[floorNum] / 1000);
            }

            //**UNLOCK** (see comment in recordElevatorDestination)

            //Reminder: assignments are stored at one higher because 0 cannot be used in thousands position.
            //A zero from above, will result in returning -1 or no match anyways.
            return elevatorNum - 1;

        };


        // This function is intended to be a single point of entry for asking an elevator to go somewhere new.
        // It should determine the context of the ask, and the goal is to find whether to:
        //    - GO NOW
        //    - Insert destination in an efficient order / position
        //    - Add destination at the end
        var addFloorDestination = function(elevator,destination, inside, ignoredup = false, direction = "") {
            var currentFloor = elevator.currentFloor();
            var maxPeople = elevator.maxPassengerCount();
            var loadFactor = elevator.loadFactor();
            var currentCount = maxPeople * loadFactor;
            var currentDirection = elevator.destinationDirection();
            var elevatorNumber = elevator.number;

            // First check to see if the elevator is already going to the requested floor
            var inList = -1;
            
            //FUTURE - There is a design gap currently where inList may not be for the right direction needed
            //         In a future version, make sure to only 'do nothing' when we are stopping for the right direction.
            //var inListDirMultiplier = direction == "down" ? -1 : 1;

            if (elevator.destinationQueue.length > 0)
            {
                inList = elevator.destinationQueue.findIndex(x => {return x == destination;});
            }
            
            // Need to work out the direction if it was not specified
            if (direction == "")
            {
                // Someone is asking the elevator to stop right now
                if (destination == currentFloor && !inside) {
                    direction = "stopped";
                }
                // Otherwise, its above or below where we're at
                else if (destination > currentFloor) {
                    direction = "up";
                }
                else {
                    direction = "down";
                }
            }

            // If this elevator has nowhere else to go...
            if (elevator.destinationQueue.length == 0)
            {
                // just add the destination to the array
                elevator.destinationQueue.push(destination);

                // Could be going up _or_ down if we were asked to stop right away
                // and were previously empty (0-length array)
                if (destination == currentFloor && !inside) {
                    elevator.goingUpIndicator(true);
                    elevator.goingDownIndicator(true);
                    elevator.directionLight = "stopped";
                }
                // Otherwise set lights and direction based on the floor destination
                else if (destination > currentFloor) {
                    elevator.goingUpIndicator(true);
                    elevator.goingDownIndicator(false);
                    elevator.directionLight = "up";
                }
                else {
                    elevator.goingUpIndicator(false);
                    elevator.goingDownIndicator(true);
                    elevator.directionLight = "down";
                }
                console.log("[elevator]["+elevatorNumber+"]["+currentFloor+"]["+currentDirection+"]First Destination: " + destination);
            }
            // If we found the same floor already in the destination, then just exit without changing anything.
            // NOTE: See note above labeled FUTURE - This has a design gap where if the stop is for the wrong direction, 
            // then users would not get on. We are currently relying on the ratingFactor and passingFloor functions simply not to do this.
            else if (inList > -1)
            {
                //do nothing;
                console.log("[elevator]["+elevatorNumber+"]["+currentFloor+"]["+currentDirection+"]Already traveling to: " + destination);
                return;
            }
            // If this request was for an empty elevator, just add the destination at the end, because the queue size was not 0 to get here.
            else if (loadFactor == 0 && !inside)
            {
                elevator.destinationQueue.push(destination);
                console.log("[elevator]["+elevatorNumber+"]["+currentFloor+"]["+currentDirection+"]Empty moving elevator, end of queue: " + destination);
            }
            // If here, then the elevator is either not empty, has current destinations already, or a user on the inside pressed the button.
            else
            {
                // We need to find the best place to insert the current destination.
                var insertat = -1;

                // The goal will be to numerically find the index of current destinations for which is either just under... or just over
                // the requested destination.
                if (direction == "up")
                {
                    insertat = elevator.destinationQueue.findIndex(x => {return destination < x;});
                }
                else if (direction == "down")
                {
                    insertat = elevator.destinationQueue.findIndex(x => {return destination > x;});
                }

                if (insertat > -1)
                {
                    //If there was a good location match above, then insert the destination into the queue at that spot
                    elevator.destinationQueue.splice(insertat,0,destination);
                    console.log("[elevator]["+elevatorNumber+"]["+currentFloor+"]["+currentDirection+"]["+direction+"] Adding: " + destination + " before: " + elevator.destinationQueue[insertat] + " Index: " + insertat);
                }
                else
                {
                    //Otherwise, no good spot found, so add the destination on the end
                    //Ideally this path should be never used, but is a fail-safe.
                    elevator.destinationQueue.push(destination);
                    console.log("[elevator]["+elevatorNumber+"]["+currentFloor+"]["+currentDirection+"]["+direction+"] Adding: " + destination + " at the end.");
                }

            }

            // This function tells the game to re-read the destination array and make needed adjustments.
            // This way we can shift, push, move, etc, and the game will update movements in real-time once this function is called.
            elevator.checkDestinationQueue();

            // Early on in writing this solution, I had bugs that would trigger this failure check here
            // Its not been needed since.
            if (elevator.destinationQueue === undefined || elevator.destinationQueue.length === 0)
            {
                debugger;
            }

            console.log("[elevator]["+elevatorNumber+"]["+currentFloor+"]["+currentDirection+"]["+elevator.destinationQueue.toString()+"] UPDATED");

        };

        
        // Returns how many times a floor request button was pressed
        // This information is stored in the floor_lights array.
        // This is only called from ratingFactor
        var getFloorCount = function(floorNum,direction)
        {
            //Up counts are in thousands
            var upCount = Math.round(floor_lights[floorNum] / 1000);
            //Down counts are in ones place
            var downCount = floor_lights[floorNum] % 1000;

            if (direction == "down")
            {
                return downCount;
            }

            if (direction == "up")
            {
                return upCount;
            }

            // If direction is something unexpected... just return whichever is higher
            if (upCount > downCount)
            {
                return upCount;
            }

            return downCount;
            
        };


        //Function that stores all logic for whether one elevator is better than another
        //Allows for tweaking the idle/empty assignment bias without changing the program architecture
        //Higher returns should bet better. (internal lower-preferred items are converted to higher values inside below)
        //Called only from assignLogic
        var ratingFactor = function(elevator,floorNum,direction="")
        {
            var currentFloor = elevator.currentFloor();
            var maxPeople = elevator.maxPassengerCount();
            var loadFactor = elevator.loadFactor();
            var currentCount = maxPeople * loadFactor;
            var currentDirection = elevator.destinationDirection();
            var elevatorNumber = elevator.number;

            var distance = 0; // lower is preferred
            var urgency = 0; // higher is preferred
            var order = 0; // lower is preferred

            //How far away is it? -- lower is preferred
            distance = Math.abs(currentFloor - floorNum);
            //How many times was the button pressed -- higher is preferred
            urgency = getFloorCount(floorNum,direction);

            //Which order was this floor in the request queue? -- lower is preferred
            if (direction == "up" || direction == "down")
            {
                order = floor_buttons.findIndex(function(x){ return x == (direction == "down" ? -1 : 1) * floorNum;});
            }
            else
            {   
                //This will be the most common path as assignLogic uses "any" for direction
                //It will match either up or down, since idle elevators should not care from a rating perspective
                
                //Future: An improved logic test would be to add _another_ rating somehow for whether there are 
                //  MORE ups waiting past a lower floor and/or MORE downs waiting past an upper floor, that the 
                //  assigned elevator will most likely pick up and stop at after the first.
                order = floor_buttons.findIndex(function(x){ return floorNum == Math.abs(x);});
            }

            if (order == -1) 
            { 
                //If this floor wasn't found, set order to be at the end, as all the other floors in the button list have priority
                order = floor_buttons.length - 1;
            }

            //Now we need to adjust the values so that they are all oriented towards Higher == preferred
            var orderMult = floor_buttons.length - order;
            var distanceMult = all_floors.length - distance;
            var urgencyMult = urgency;

            //Now higher is better for all, so return each multiplied by one another
            //A future design option here would be to assign weight multipliers to each as a mechanism to tune the best assignments
            return (orderMult * distanceMult * urgencyMult);            
        };

        //Function for determining whether an idle elevator should be assigned to a given floor request
        //Called only from the main idle assignment function: sendAllElevators
        var assignLogic = function(elevator) 
        {
            //If somehow we got here and and an elevator either isn't idle, or it has people in it
            //then just return that it was not assigned and move to the next elevator
            if (elevator.idle == false) return 0;
            if (elevator.loadFactor() > 0) return 0;

            var floorSelected = -1;
            var floorMaxRating = -1;
            var lastRating = -1;

            //Scan through floor button requests
            for(var f=0; f < floor_buttons.length; f++)
            {
                // Don't assign if another elevator has committed to that floor _and_ direction already
                if (checkElevatorDestination(Math.abs(floor_buttons[f]),floor_buttons[f] > -1 ? "up" : "down") > -1) continue;

                //Get the rating value for this elevator / floor request combo
                lastRating = ratingFactor(elevator,Math.abs(floor_buttons[f]),"any");

                //Look for the highest rating value from all the floor requests
                if (lastRating >= floorMaxRating)
                {
                    //Record the floor number value (and direction, since its signed)
                    floorSelected = floor_buttons[f];
                    floorMaxRating = lastRating;
                }

            }
            
            //Unexpected, but if somehow, there is no appropriate floor match for this elevator, return as not-matched
            if (floorSelected == -1) return 0;

            //Record the assignment / commitment of this elevator in the assignments array
            //Since floor_buttons values are signed to store direction, thats converted back to up/down here
            recordElevatorDestination(elevator,Math.abs(floorSelected),floorSelected > -1 ? "up" : "down");

            //This should always be true here, but just in case, only change the indicators if the elevator is idle
            if (elevator.idle == true)
            {
                //Set the lights based on the direction of the next floor
                if (Math.abs(floorSelected) > elevator.currentFloor())
                {
                    elevator.goingUpIndicator(true);
                }
                else
                {
                    elevator.goingDownIndicator(true);
                }
            }

            //Record that this elevator is now no longer idle, just before actually setting the destination
            elevator.idle = false;

            //Log the idle elevator assignment results
            console.log("[elevator]["+elevator.number+"]["+elevator.currentFloor()+"][idle] Heading to: " + floorSelected + " Remaining: " + floor_buttons.toString());

            //Call the destination assignment and sorting function with the new floor
            addFloorDestination(elevator,Math.abs(floorSelected),false,true, floorSelected > -1 ? "up" : "down");

            //Return 1 == this elevator was assigned and sent away
            return 1;
        };

        //Main idle elevator scanning and assignment loop        
        var sendAllElevators = function()
        {
            //If there are no requests, just exit quickly
            if (floor_buttons.length == 0) return;

            //If this is already true before SETTING it to true below, then just wait for the existing loop to finish.
            if (isAssignmentLoopRunning) return;

            //This allows other events not to re-call this loop if its already running.
            //This was added as a test to see if it helped some of the concurrency issues.
            //The impact of adding this is mostly unknown really.
            isAssignmentLoopRunning = true;

            var assigned = 0;
            var candidates = floor_buttons.length;

            //Scan through small elevators
            //Smaller elevators are assigned to call requests first because since the game is biased towards larger people on 0,
            //I let the larger elevators fall back down to 0 when idle and pick up those requests specifically
            //Future: What _could_ be added in the future is an additional rating factor above that specifically matched 
            //  larger elevators with floor 0 on purpose. What is really missing int the game is knowing how many people are waiting
            //  on each floor. Not every person waiting presses the button is what I found.
            for(var e=0; e < all_elevators.length; e++)
            {
                // TEST / TEMPORARY? Maybe?
                // For now, exit the main loop for each elevator assignment. The loop will be called again on a regular basis when
                // any of the floor lights change.
                // This seems to help some, but might be removed in a future version
                if (assigned > 0) {
                    isAssignmentLoopRunning = false;
                    return;
                }

                // No reason to keep looping if / once all requests have been assigned.
                if (assigned >= candidates) break;
                
                //Only assign small elevators in the first loop
                if (all_elevators[e].isLarge) continue;
                
                // Ask each elevator to consider the current requests 
                assigned += assignLogic(all_elevators[e]);
            }
            //Scan through large elevators
            for(var e=0; e < all_elevators.length; e++)
            {
                // TEST / TEMPORARY? Maybe?
                // For now, exit the main loop for each elevator assignment. The loop will be called again on a regular basis when
                // any of the floor lights change.
                // This seems to help some, but might be removed in a future version
                if (assigned > 0) {
                    isAssignmentLoopRunning = false;
                    return;
                }

                // No reason to keep looping if / once all requests have been assigned.
                if (assigned >= candidates) break;
                
                //Only assign large elevators in the second loop
                if (!all_elevators[e].isLarge) continue;
                
                // Ask each elevator to consider the current requests
                assigned += assignLogic(all_elevators[e]);
            }
            isAssignmentLoopRunning = false;
        };

        // Moving elevators that have room, and passing a floor with a light lit for the direction its going should stop
        // based on the logic in passingFloor below. However, its entirely possible that an empty / idle elevator was already
        // committed and sent and just has not reached the floor yet.
        // 
        // This function is inteded to be called by both stoppedAtFloor and updateButtons 
        // (likely overkill // maybe should only be updateButtons??) to cancel a pending empty elevator assignment.
        var stopEmptySends = function(floorNum,direction)
        {            
            // I started from right to left, because I noticed that right most elevators were not getting canceled.
            // Oddly this change helped to not send as many empty elevators and I dont exactly know why.
            for(var s=all_elevators.length - 1;s>-1;s--)
            {
                // If its empty, and it was coming to this floor next...
                if (all_elevators[s].destinationQueue.length > 0 &&
                    all_elevators[s].destinationQueue[0] == floorNum &&
                    all_elevators[s].loadFactor() == 0 

                    //Given concurrency issues mentioned, the program works better with this line commented out.
                    //Just cancel the empty sends regardless of whether there is an assignment already. 
                    //&& checkElevatorDestination(floorNum,direction) != s
                    )
                {
                    // Then just remove the first destination
                    all_elevators[s].destinationQueue.shift();
                    console.log("[elevator][" + all_elevators[s].number + "] Update: [" + all_elevators[s].destinationQueue.toString() + "]");
                    
                    // And tell the game to update its logic
                    all_elevators[s].checkDestinationQueue();

                    // Ideally, there could be a debugger assert here to confirm the destination queue is now empty... 
                    // But I have left that out for now.

                    if ( all_elevators[s].destinationQueue == undefined ||
                        all_elevators[s].destinationQueue == null ||
                        all_elevators[s].destinationQueue.length == 0)
                        {
                            // If the queue IS empty (which is expected now)
                            // Declare the elevator as idle now.
                            all_elevators[s].idle = true;
                        }
                }
            }
        };

        // This function used when determining whether the given elevator is closer than the elevator saved in the assignments array
        // Returns a boolean if the given elevator is closer
        var isElevatorCloser = function(elevator,floorNum,direction)
        {
            // Get assigned elevator first
            var otherElevatorNum = checkElevatorDestination(floorNum,direction);
            // If none-assigned, simply return true
            if (otherElevatorNum < 0) return true;

            // Otherwise calculate both distances and compare
            var distance1 = Math.abs(elevator.currentFloor() - floorNum);
            var distance2 = Math.abs(all_elevators[otherElevatorNum].currentFloor() - floorNum);

            return (distance1 < distance2);
        };


        // Function to either increment or clear direction/button requests in the floor_lights
        // Called from all three button callback events.
        // Note that when clear parameter == true, it will clear all requests for that direction on that floor
        // The order of the requests are also stored in the floor_buttons array as well
        var incrementFloorCount = function(floorNum,direction, clear = false)
        {
            // Start off initializing any existing counts for the given floor
            var upCount = Math.round(floor_lights[floorNum] / 1000);
            var downCount = floor_lights[floorNum] % 1000;
            var index = -1;
            
            // Apply updated downCount or upCount based on whether the request was up or down
            // Note: only one copy of a floor and direction is saved in floor_buttons
            //       however, incremented counts for that direction will still be updated in floor_lights array.
            if (direction == "down")
            {
                if (clear)
                {
                    downCount = 0;
                }
                else
                {
                    //Add first down request to floor_buttons as a negative number for the floor number
                    if (downCount == 0) floor_buttons.push(floorNum * -1);
                    downCount++;                    
                }                
            }
            else
            {
                if (clear)
                {
                    upCount = 0;
                }
                else
                {
                    //Add first up request to floor_buttons with the floor number
                    if (upCount == 0) floor_buttons.push(floorNum);
                    upCount++;                    
                }
            }

            if (clear)
            {
                // If clearing the current floor and direction, then search through floor_buttons and delete instances
                // There should only be one, but the code will find and remove any instance
                index = floor_buttons.findIndex(function(x){return x == (direction == "down" ? -1:1) * floorNum;});
                while(index> -1)
                {
                    floor_buttons.splice(index,1);
                    index = floor_buttons.findIndex(function(x){return x == (direction == "down" ? -1:1) * floorNum;});
                }
            }

            // Set updated count values based on needed adjustments for the current floor
            // Up values saved in 1000s, down in ones
            floor_lights[floorNum] = (upCount * 1000) + downCount;

            console.log("[floor][" + floorNum + "]" + direction + (clear ? " cleared":" pressed")+" -- Button Count - Up:" + upCount + " Down:" + downCount);
        };


        //
        // Elevator Functions Section
        //
        // In this section are event functions the game will call for certain conditions on each elevator
        //
        // 

        // The game calls this function whenever an elevator is idle
        // 'this' is always the elevator idleFunction is called on
        var idleFunction = function() 
        {
            var currentFloor = this.currentFloor();
            var maxPeople = this.maxPassengerCount();
            var loadFactor = this.loadFactor();
            var currentCount = maxPeople * loadFactor;
            var currentDirection = this.destinationDirection();

            // Set this elevator to idle, record direction as stopped, and clear indicator lights
            this.idle = true;
            this.directionLight = "stopped";
            this.goingUpIndicator(false);
            this.goingDownIndicator(false);

            // If there are no requests... and this is a larger elevator, send it to 0 floor
            // Otherwise, just tell the idle elevator loop to go and assign.
            if (floor_buttons.length==0)
            {
                if (this.isLarge)
                {
                    this.destinationQueue.push(0);
    
                    this.checkDestinationQueue();
                }
            }
            else
            {
                all_elevators[0].sendAllElevators();
            }
        };

        // This function called by the game to indicate a user has pressed a button inside.
        // Normally this only happens when the elevator is stopped on a floor... but I have seen it sometimes after its in motion
        // so the logic must handle it happening any time.
        var insideButton = function(floorNum) 
        {
            var currentFloor = this.currentFloor();
            var maxPeople = this.maxPassengerCount();
            var loadFactor = this.loadFactor();
            var currentCount = maxPeople * loadFactor;
            var currentDirection = this.destinationDirection();

            // If the elevator was already stopped, then just set indicators and direction based on whichever floor the user chooses.
            // Note: this is actually checking directionLight specifically, which is only set by this code and NOT the game.
            // directionLight is reset to stopped, ONLY when there is no one onboard, or the elevator is idle. 
            // Thus, this code is only used for empty elevators that reach their first floor.
            if (floorNum > currentFloor)
            {
                if (this.directionLight == "stopped")
                {
                    this.directionLight == "up";
                    this.goingUpIndicator(true);
                    this.goingDownIndicator(false);
                }
            }
            else {

                if (this.directionLight == "stopped")
                {
                    this.directionLight == "down";
                    this.goingUpIndicator(false);
                    this.goingDownIndicator(true);
                }
            }

            console.log("[elevator][" + this.number + "]" + "Floor Pressed: " + floorNum);
            
            // Add a new destination to this elevator
            // Tell the function it was from an inside user, and which direction the elevator is currently traveling
            // The current direction helps set where to insert the floor at
            addFloorDestination(this,floorNum, true, true, this.directionLight);
        };

        // passingFloor function is called by the game whenever any elevator approaches another floor
        // Inside this function we do several different checks: Should we stop?, Which direction are we going?, Are we actually idle?
        var passingFloor = function(floorNum,direction) 
        {
            var currentFloor = this.currentFloor();
            var maxPeople = this.maxPassengerCount();
            var loadFactor = this.loadFactor();
            var currentCount = maxPeople * loadFactor;
            var currentDirection = this.destinationDirection();
            var nextDestination = this.destinationQueue[0];

            // If there is no destination, and no one onboard, then this elevator is idle and about to be "stopped" state
            // Otherwise, make sure idle is set to false just in case
            if ((nextDestination == undefined || nextDestination == null || this.destinationQueue.length == 0)
                && loadFactor == 0)
            {
                this.idle = true;
                currentDirection = "stopped"
            }
            else
            {
                this.idle = false;
            }
            

            // Log empty elevator movements and destination
            if (loadFactor == 0)
            {
                console.log("[elevator]["+this.number+"]["+currentFloor+"]Passing: " + floorNum + " on the way to: " + nextDestination);
            }


            // Determine whether this elevator should STOP at the floor its passing to pick someone up.
            // Ideally, the elevator should only stop when it has space, AND is going the same direction as the request.

            // thus next two if statements are if direction is the same, if the light on the passing floor matches that direction,
            // if the elevator isn't full, and if the other assigned elevator isnt already arriving

            // The last bit is speculative, but I believe that it has helped
            if (currentDirection == "down" 
                && all_floors[floorNum].downLight == true 
                && loadFactor < 0.9 
                && isElevatorCloser(this,floorNum,"down")
                // && checkElevatorDestination(floorNum,"down") < 0
                )
            {
                // If there is another elevator assigned, then stop anyways (because we were closer)
                // However tell the assignment function to ignore the duplicate.
                if (checkElevatorDestination(floorNum,"down") > -1)
                {
                    recordElevatorDestination(this,floorNum,"down",true);    
                }
                else
                {
                    recordElevatorDestination(this,floorNum,"down");
                }                
                
                this.destinationQueue.unshift(floorNum);
                console.log("[elevator][" + this.number + "] Update: [" + this.destinationQueue.toString() + "]");
                this.checkDestinationQueue();
            }
            else if (currentDirection == "up" 
                     && all_floors[floorNum].upLight == true 
                     && loadFactor < 0.9 
                     && isElevatorCloser(this,floorNum,"up")
                     // && checkElevatorDestination(floorNum,"up") < 0
                     )
            {
                // If there is another elevator assigned, then stop anyways (because we were closer)
                // However tell the assignment function to ignore the duplicate.
                if (checkElevatorDestination(floorNum,"up") > -1)
                {
                    recordElevatorDestination(this,floorNum,"up",true);    
                }
                else
                {
                    recordElevatorDestination(this,floorNum,"up");
                }
                this.destinationQueue.unshift(floorNum);
                console.log("[elevator][" + this.number + "] Update: [" + this.destinationQueue.toString() + "]");

                this.checkDestinationQueue();
            }

            // Set / reset the direction variable based on what happened above
            this.directionLight = currentDirection;
                        
        };

        // The game calls this function when an elevator stops at a floor
        // This code uses this function for two reasons: 1. Set indicators correctly, and 2. record elevator commitment in cases 
        //   where other elevators might be passing (this should prevent them from stopping as well)
        var stoppedAtFloor = function(floorNum) 
        {
            var currentFloor = this.currentFloor();
            var maxPeople = this.maxPassengerCount();
            var loadFactor = this.loadFactor();
            var currentCount = maxPeople * loadFactor;
            var currentDirection = this.destinationDirection();
            
            // If we are empty, and there are lights on... then just have the elevator lights match the floor lights
            if (loadFactor == 0 && (all_floors[floorNum].upLight || all_floors[floorNum].downLight))
            {
                this.goingUpIndicator(all_floors[floorNum].upLight);
                this.goingDownIndicator(all_floors[floorNum].downLight);
            }
            else
            {
                // Otherwise follow the logic in our purpose built function for setting the elevator lights
                setDirections(this,this.directionLight,floorNum);
            }

            // Alert other moving elevators not to stop...

            // If we were moving down...
            if (this.directionLight == "down")
            {
                // and the downlight was on... and there were no committed elevators...
                if (all_floors[floorNum].downLight == true && checkElevatorDestination(floorNum,"down") < 0)
                {
                    // record our commitment until the lights go out...
                    recordElevatorDestination(this,floorNum,"down");
                }
                // and stop other empty elevators which might already be on the way.
                // Note: I have tested calling this from "passingFloor"... but found that elevators did not always stop
                // It seems to work better calling the cancelation after the stopped function is called.
                stopEmptySends(floorNum,"down");               
            }

            // If we were moving up...
            if (this.directionLight == "up")
            {
                // and the up light was on... and there were no committed elevators...
                if (all_floors[floorNum].upLight == true && checkElevatorDestination(floorNum,"up") < 0)
                {
                    // record our commitment until the lights go out...
                    recordElevatorDestination(this,floorNum,"up");
                }
                // and stop other empty elevators which might already be on the way.
                // Note: I have tested calling this from "passingFloor"... but found that elevators did not always stop
                // It seems to work better calling the cancelation after the stopped function is called.
                stopEmptySends(floorNum,"up");
            }
            
        };


        //
        // Floor Functions Section
        //
        // In this section are event functions the game will call for certain conditions on each floor
        //
        // 

        // Game calls this function from a floor where the up request button is pressed.
        // 'this' is the floor object in all cases.
        // Here we just record that the light is now on, and increment the counts for this floor and direction.
        var upPressed = function() 
        {
            var floorNum = this.floorNum();

            this.upLight = true;

            incrementFloorCount(floorNum,"up");
        };

        // Game calls this function from a floor where the down request button is pressed.
        // 'this' is the floor object in all cases.
        // Here we just record that the light is now on, and increment the counts for this floor and direction.
        var downPressed = function() 
        {
            var floorNum = this.floorNum();
     
            this.downLight = true;

            incrementFloorCount(floorNum,"down");            
        };
        

        // The game calls this function on any floor when the state of the lights change.
        // The game will pass an object containing the new light states for the given floor.
        // The 'this' object is always the floor object
        var updateButtons = function(buttonstates) 
        {
            // record which floor number
            var floorNum = this.level;

            // check whether up or down is lit up
            var upState = buttonstates.up == "activated";
            var downState = buttonstates.down == "activated";
            
            // check against our previous recorded state to see if there was a change
            if (all_floors[floorNum].upLight && !upState)
            {
                // light now out - set light variable to off
                all_floors[floorNum].upLight = false;

                // Check if there are committed elevators for this floor and direction...
                if (checkElevatorDestination(floorNum,"up") > -1)
                {
                    // ... and clear them
                    clearElevatorDestination(floorNum,"up");
                }

                // Also clear the light count data as well for this direction
                incrementFloorCount(floorNum,"up", true);
            }

            // check against our previous recorded state to see if there was a change
            if (all_floors[floorNum].downLight && !downState)
            {
                // light now out - set light variable to off
                all_floors[floorNum].downLight = false;

                // Check if there are committed elevators for this floor and direction...
                if (checkElevatorDestination(floorNum,"down") > -1)
                {
                    // ... and clear them
                    clearElevatorDestination(floorNum,"down");
                }

                // Also clear the light count data as well for this direction
                incrementFloorCount(floorNum,"down", true);
            }

            // If the idle assignment loop isn't already running... start it, because there may be assignments to make
            if (!isAssignmentLoopRunning)
            {
                all_elevators[0].sendAllElevators();
            }
        };


        //
        // Main Init Code Section
        //
        // Finally, we are at the relatively small section which is actual code executed upon init
        //
        // 

        //Specifically, we store our idle loop in the first elevator because only the base elevators array is 
        //available from the 'update' function below, and we will ALWAYS have at least one elevator.
        elevators[0].sendAllElevators = sendAllElevators;

        //Make our own copy of elevators
        all_elevators = new Array(elevators.length);
        //This will actually accumulate the total capacity across all elevators
        var avgsize = 0;
        for(var i = 0; i < elevators.length; i++)
        {
            //There are some extra properties we add to each elevator, like number directionLight, idle, and isLarge

            //Let each elevator know which number it is
            elevators[i].number = i;

            //Give it a string, that will be "up", "down", or "stopped". The values are expected to 
            //match the output of the 'destinationDirection()' function.
            elevators[i].directionLight = "stopped";
            
            //Set a boolean for whether the elevator is actually idle
            elevators[i].idle = true;

            //Set the call-back functions on 4 different elevator events.
            //These will be called by the game when the matching events happen.
            elevators[i].on("idle",idleFunction);
            elevators[i].on("floor_button_pressed",insideButton);
            elevators[i].on("passing_floor",passingFloor);
            elevators[i].on("stopped_at_floor",stoppedAtFloor);
            
            //place a reference/copy in our own array
            all_elevators[i] = elevators[i];

            //accumulate the capacity for large / small determination
            avgsize += elevators[i].maxPassengerCount;
        }

        //Calculate the average capacity of elevator
        avgsize = avgsize / elevators.length;

        //Now go back across all elevators and set whether they are large or not.
        //The game has some variations, but mostly sticks with just large and small in each level.
        //If all the same size, then it should end up with isLarge == false for all of them.
        for(var q = 0; q < elevators.length; q++)
        {
            if (elevators[q].maxPassengerCount > avgsize)
            {
                elevators[q].isLarge = true;
            }
            else
            {
                elevators[q].isLarge = false;
            }
        }

        // Create a copy array of all floors
        all_floors = new Array(floors.length);        

        // Create an array that stors whether up or down lights are on (and how many presses) for each floor
        floor_lights = new Array(floors.length);

        // Loop through each floor
        for(var j = 0; j < floors.length; j++)
        {
            // Add our own properties like the floor number and whether the up / down light are on to each floor
            floors[j].number = j;
            floors[j].upLight = false;
            floors[j].downLight = false;

            //Set the call-back functions on floor events
            floors[j].on("down_button_pressed",downPressed);
            floors[j].on("up_button_pressed",upPressed);

            //HACK ** HACK ** HACK
            //Soooo this event is not listed in the game documentation.
            //However, I found it while debugging the game at one point.
            //To be quite honest, I have NO WAY to keep track of when floor lights turn OFF after pressed without this hack.
            //There is no function to check if the light is still on.
            //I _USED_ to use inside button press as an indication of floor light change, HOWEVER, I found a bug / design flaw
            //  where people would _NOT_ press the inside button of the elevator if their destination was already shown.
            //Because of that, this added hack, is actually the only way to track this, and is a huge gap in the game otherwise.
            floors[j].on("buttonstate_change",updateButtons);

            //place a reference/copy in our own array
            all_floors[j] = floors[j];

            //No lights on at the start of the game
            floor_lights[j] = 0;
        }

        //Initialize array for tracking floor requests
        floor_buttons = new Array();      

        //Initialize array for tracking elevator commitments
        assignments = new Array(floors.length);
    },
    update: function(dt, elevators, floors) 
    {
        // The game calls this function periodically, without too much of a guarantee as to how often.
        // There is likely an event or series of events that end up with this being called.
        // dt is the number of game seconds that passed since the last time update was called

        // In past game solutions, I would have VERY large state machine if statements in this function.

        // However, for this solution, I ended up making nearly everything event driven.
        // I do still _try_ the idle elevator loop on each update.
        // It should just return if another was already running.

        elevators[0].sendAllElevators();
    }
       

}
