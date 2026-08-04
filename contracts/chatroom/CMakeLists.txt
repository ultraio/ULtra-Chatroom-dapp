cmake_minimum_required(VERSION 3.5)
project(chatroom)
find_package(cdt)
include(CDTWasmToolchain)
add_contract(chatroom chatroom ${CMAKE_CURRENT_SOURCE_DIR}/src/chatroom.cpp)
target_include_directories(chatroom PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
# Ricardian contracts for the human-facing actions (ban/unban). abigen picks up
# chatroom.contracts.md from the -R ricardian dir; without it CDT warns
# "action <ban> does not have a ricardian contract". on_transfer is a notify
# handler, not a dispatched action, so it needs none.
target_compile_options(chatroom PUBLIC -R${CMAKE_CURRENT_SOURCE_DIR}/ricardian)
# Test hook: `cmake -DCHATROOM_MAX_ROOM_MESSAGES=3 ..` builds a small-window
# variant so the prune path is exercisable without posting 1000+ messages.
# Leave unset for production builds (the header defaults to 1000).
if(DEFINED CHATROOM_MAX_ROOM_MESSAGES)
  target_compile_definitions(chatroom PRIVATE CHATROOM_MAX_ROOM_MESSAGES=${CHATROOM_MAX_ROOM_MESSAGES})
endif()
set_target_properties(chatroom PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}")
