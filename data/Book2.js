export const data = [
  {
    Book: {
      id: 1,
      Name: "Pattern Pals: Sleepover Similarities",
      Characters: [
        {Name:"Narrator", img: require("../Pictures/narrator.png")},
        {Name:"Clara",img: require("../Pictures/book1/Clara_avatar.jpg")},
        {Name:"Zoe",img: require("../Pictures/book1/Zoe_avatar.jpg")},
      ],

      Pages: {
        Cover: {
          img: require("../Pictures/book2/cover.png"),
          question: "You will see questions in this box while reading the book. Feel free to use them at your convenience.",
          text: [
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "The Pattern Pals: Sleepover Similarities",
            }
          ],
        },
        PageOne: {
          img: require("../Pictures/book2/Page_1.jpg"),
          question: "What is something fun you like to do with your friends?",
          text: [
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<emphasis level='strong'>“Welcome to my house!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Clara beamed.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<emphasis level='strong'>“This is going to be so much fun!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "sang Zoe.<break time='1s'/>  It was their first sleepover.",
            },
          ],
        },

        PageTwo: {
          img: require("../Pictures/book2/Page_2.jpg"),
          question: "Describe the pattern on the sleeping bags.",
          expectedAnswer: "They alternate.",
          text: [
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<emphasis level='strong'> “Our sleeping bags have the same pattern!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Clara said.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“Yours is yellow, blue, yellow, blue<break time='1s'/>…”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“mine is green, purple, green, purple. <break time='1s'/> <prosody rate='1.6'>Zip, zap, zip, zap!</prosody>”",
            },
          ],
        },
        PageThree: {
          img: require("../Pictures/book2/Page_3.jpg"),
          question: "Where do you think Clara will hide?",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<emphasis level='strong'>“Let’s play hide and seek!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Zoe.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“You count, and I’ll hide,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "said Clara.",
            },
          ],
        },
        PageFour: {
          img: require("../Pictures/book2/Page_4.jpg"),
          question: "Which objects in the room do not have a pattern?",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“… eighteen, nineteen, twenty!”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Zoe.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“<emphasis level='strong'> Ready or not, here I come!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "She looked around. <break time='1s'/>No Clara.",
            },
          ],
        },
        PageFive: {
          img: require("../Pictures/book2/Page_5.jpg"),
          question: "What color would the next bunch of flowers be if there was one more?",
          expectedAnswer: "Blue or orange — either answer works.",
          text: [
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Zoe checked under the blanket. <break time='1s'/> No Clara.",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "She opened the closet. <break time='1s'/> No Clara.",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "She looked behind some flowers. <break time='1s'/> <emphasis level='strong'> No Clara there either!</emphasis>",
            },
          ],
        },
        PageSix: {
          img: require("../Pictures/book2/Page_6.jpg"),
          question: " What is the pattern on the curtains?",
          expectedAnswer: "A flower, flower, heart pattern.",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<prosody volume='-6dB' pitch='-2st'> “How will I find Clara?”</prosody>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "Zoe worried.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<prosody volume='-6dB' pitch='-2st'>“There’s so many places to look…”</prosody>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "She checked in front of the curtains.",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "No Clara.",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "She peeked behind the curtains...",
            },
        
          ],
        },
        PageSeven: {
          img: require("../Pictures/book2/Page_7.jpg"),
          question: "Tell me about a time you felt surprised.",
          text: [
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<emphasis level='strong'><prosody pitch='+10%' rate='2.5'>Ta-</prosody><prosody pitch='+30%' rate='1.0'>da!</prosody></emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Clara cried.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<emphasis level='strong'>“SQUAWK!”</emphasis>",
            },
          ],
        },
        PageEight: {
          img: require("../Pictures/book2/Page_8.jpg"),
          question: "How do you think Zoe is feeling?",
          text: [
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<prosody volume='-6dB' pitch='-2st'>“Sorry!”</prosody>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Clara said.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“I didn’t mean to scare you.”"
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<prosody volume='-2db' rate='0.7' pitch='-2st'>“I thought<break time='1s'/>—I thought I might not find you,”</prosody>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "stammered Zoe.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue: "“<prosody volume='-2db' rate='0.7' pitch='-2st'>Your house seems really different from mine.”</prosody>",
            },
          ],
        },
        PageNine: {
          img: require("../Pictures/book2/Page_9.jpg"),
          question: "Describe the pattern on Clara.",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“I miss my house,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Zoe admitted.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "“Maybe your house is more like mine than you think,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Clara.",
            },
          ],
        },
        PageTen: {
          img: require("../Pictures/book2/Page_10.jpg"),
          question: "What is another pattern you could make using the shapes on the curtains?",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“My curtains seem different,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Zoe.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“They go star, star, heart, star, star, heart.”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "“It’s the same pattern, though.”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Clara.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“See? Mine go flower, flower, heart, flower, flower, heart.”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“That’s just like star, star, heart!”",
            },
          ],
        },
        PageEleven: {
          img: require("../Pictures/book2/Page_11.jpg"),
          question: "Why does Clara say “zip, zap, zop?”",
          expectedAnswer: "To explain the pattern.",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“But my blanket doesn’t look like that,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Zoe.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“It has blue, yellow, and red stripes.”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "“Our blankets have the same pattern,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Clara.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“Mine goes purple, pink, green, purple, pink, green.”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue: "“Yours goes blue, yellow, red, blue, yellow, red. See?”",
            },
            {
            Reading: false,
            Character: "Clara",
            Dialogue: "“<prosody rate='1.6'>Zip, zap, zop! Zip, zap, zop</prosody>!”",
            },
          ],
        },
        PageTwelve: {
          img: require("../Pictures/book2/Page_12.jpg"),
          question: "What are some objects that have the same pattern?",
          expectedAnswer: "The flowers, the blanket, Zoe’s feather, or the pots — any one of these works.",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<emphasis level='strong'>“You’re right,”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Zoe.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“But your flowers aren’t the same.”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "“The pattern might be, though.”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "suggested Clara.",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "“Mine go blue, orange, blue, orange. How do yours go?”",
            },
          ],
        },
        PageThirteen: {
          img: require("../Pictures/book2/Page_13.jpg"),
          question: "How is “blue, orange, blue, orange” and “tall, short, tall, short” the same pattern?",
          expectedAnswer: "They both alternate.",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue: "“My flowers go tall, short, tall, short.”",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue: "“It’s the same pattern as yours!”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Zoe realized.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "<emphasis level='strong'>“<prosody rate='1.6'>Zip, zap, zip, zap</prosody>!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<emphasis level='strong'>“You got it!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Clara.",
            },
          ],
        },
        PageFourteen: {
          img: require("../Pictures/book2/Page_14.jpg"),
          question: "Which items are different colors but have the same pattern?",
          expectedAnswer: "The sleeping bags or the blankets.",
          text: [
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“Your house doesn’t seem so different anymore.”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "Zoe smiled.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“I feel better.”",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<emphasis level='strong'>“Great!”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Clara.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“One problem…<break time='1s'/> <emphasis level='strong'>I forgot my pillow!” </emphasis>",
            },
          ],
        },
        PageFifteen: {
          img: require("../Pictures/book2/Page_15.jpg"),
          question: "What is a pattern on the pillow Clara gives Zoe?",
          text: [
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "“Here’s one,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "offered Clara.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:
                "“It doesn’t match mine at home,”",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "said Zoe.",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue:"<emphasis level='strong'>“But it’s okay if some things are different!</emphasis>“",
            },
            {
              Reading: false,
              Character: "Zoe",
              Dialogue: "<emphasis level='strong'>“<prosody rate='1.6'>Zip, zap, zoodely, zoop!</prosody>”</emphasis>",
            },
            {
              Reading: false,
              Character: "Clara",
              Dialogue:
                "<emphasis level='strong'>“<prosody rate='1.6'>Zip, zap, zoodely, zoop!</prosody>”</emphasis>",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue:
                "The two friends laughed together.",
            },
            {
              Reading: false,
              Character: "Narrator",
              Dialogue: "The End.",
            },
          ],
        },
       
      },
    },
  },
];
