import { startCbmsRunner } from "@/lib/cbms";

/*
  Bills that did not reach IRD when they were raised - IRD down, the shop's
  internet down - are sent again in the background until IRD accepts them.
*/
startCbmsRunner();
